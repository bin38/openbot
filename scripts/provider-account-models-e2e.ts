// Real AgentService and ACP processes with isolated account folders and fixed local model metadata.
// No external provider, account credential, or model inference is used.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelSupportsProviderAccount } from "@openbot/contracts/account-scoped-models";
import { AGENT_PROVIDERS, DEFAULT_PROVIDER_ACCOUNT_ID } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit } from "effect";
import { z } from "zod";
import { ProviderAccountStore } from "../src/backend/agent/provider-account-store";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { ANTIGRAVITY_MANIFEST } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";

const OUT = resolve(".openbot-build/provider-account-models-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-account-models-"));
const userData = join(root, "profile");
const defaultHome = join(root, "default-gemini");
const logPath = join(root, "requests.jsonl");
const modelsPath = join(root, "added-models.json");
const executable = join(root, "runtime", "bin", "agy_acp_server");
const SHARED = "gemini-shared-fixture";
const PRIMARY = "gemini-primary-fixture";
const ADDED = "gemini-added-fixture";
const logger = createOpenBotLogger("provider-account-models-e2e");
const checks: string[] = [];
let passed = false;

const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const fallbackHome = ${JSON.stringify(defaultHome)};
const requested = process.env.GEMINI_HOME;
const home = requested && requested.startsWith(root + path.sep) ? requested : fallbackHome;
const token = path.join(home, "antigravity-acp", "acp_token.json");
const added = home !== fallbackHome;
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result}) + "\\n");
log({method:"process-start",added});
let session = 0;
function answer(message) {
  if (message.id === undefined) return;
  log({method:message.method,added,...(message.method === "session/prompt" ? {text:message.params.prompt?.[0]?.text ?? ""} : {})});
  switch (message.method) {
    case "initialize": return send(message.id,{protocolVersion:1,agentCapabilities:{auth:{logout:{}}},authMethods:[{id:"oauth-personal",name:"Google"}]});
    case "authenticate":
      fs.mkdirSync(path.dirname(token),{recursive:true});
      fs.writeFileSync(token,JSON.stringify({refresh_token:"local-fixture"}));
      return send(message.id,{});
    case "logout": fs.rmSync(token,{force:true}); return send(message.id,{});
    case "session/new": {
      if (!fs.existsSync(token)) return process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32000,message:"Authentication required"}})+"\\n");
      const names = added ? JSON.parse(fs.readFileSync(${JSON.stringify(modelsPath)},"utf8")) : [${JSON.stringify(SHARED)},${JSON.stringify(PRIMARY)}];
      return send(message.id,{sessionId:"fixture-"+(++session),models:{availableModels:names.map(modelId=>({modelId,name:modelId})),currentModelId:names[0]}});
    }
    case "session/prompt":
      if (message.params.prompt?.[0]?.text !== "/usage") throw new Error("Inference is forbidden in this fixture");
      return send(message.id,{stopReason:"end_turn"});
    default: return send(message.id,{});
  }
}
let buffer="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffer+=chunk;for(;;){const split=buffer.indexOf("\\n");if(split<0)break;const line=buffer.slice(0,split);buffer=buffer.slice(split+1);if(line)answer(JSON.parse(line));}});
`;

const unused = () => Effect.die(new Error("Browser work is outside this fixture."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

await mkdir(join(root, "runtime", "bin"), { recursive: true });
await writeFile(join(root, "runtime", ANTIGRAVITY_MANIFEST), JSON.stringify({ version: "1.4.5" }));
await writeFile(executable, fake);
await chmod(executable, 0o700);
await mkdir(join(defaultHome, "antigravity-acp"), { recursive: true });
const defaultToken = JSON.stringify({ refresh_token: "primary-fixture" });
await writeFile(join(defaultHome, "antigravity-acp", "acp_token.json"), defaultToken);
await writeFile(modelsPath, JSON.stringify([SHARED, ADDED]));
const accounts = new ProviderAccountStore(join(userData, "accounts.json"), join(root, "accounts"));
await runCauseEffect(accounts.load());
const added = await runCauseEffect(accounts.create("antigravity"));
assert.ok(added);
await mkdir(join(accounts.home(added), "antigravity-acp"), { recursive: true });
await writeFile(
  join(accounts.home(added), "antigravity-acp", "acp_token.json"),
  JSON.stringify({ refresh_token: "added-fixture" }),
);
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, join(root, "home"), database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  providerAccounts: accounts,
  preferredProvider: "codex",
  developmentDefaults: false,
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "antigravity"),
  bundledExecutables: { antigravity: executable },
  credentials: { ...NO_PROVIDER_CREDENTIALS, agentEnvironment: () => ({ GEMINI_HOME: defaultHome }) },
  prepareAgentWorkspace: () => Effect.void,
});

function waitForCatalog(accountId: string, hasAddedModel = true): Promise<void> {
  return new Promise((done, reject) => {
    const check = () => {
      const models = service
        .listLocalModels()
        .filter((model) => model.provider === "antigravity" && modelSupportsProviderAccount(model, accountId));
      const connected = service
        .getStatus()
        .providers?.find((provider) => provider.id === "antigravity")
        ?.accounts?.some((account) => account.id === accountId && account.state === "connected");
      if (
        connected &&
        models.some((model) => model.id === SHARED) &&
        models.some((model) => model.id === ADDED) === hasAddedModel
      ) {
        clearTimeout(timeout);
        service.off("event", check);
        done();
      }
    };
    const timeout = setTimeout(() => {
      service.off("event", check);
      reject(new Error("The fixture account catalog did not become ready."));
    }, 15000);
    service.on("event", check);
    check();
  });
}

const requestSchema = z.object({ method: z.string(), added: z.boolean(), text: z.string().optional() });
async function requests() {
  return (await readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => requestSchema.parse(JSON.parse(line)));
}
const modelIds = (accountId: string) =>
  service
    .listLocalModels()
    .filter((model) => model.provider === "antigravity" && modelSupportsProviderAccount(model, accountId))
    .map((model) => model.id)
    .sort();
async function refused<A, E>(operation: Effect.Effect<A, E>) {
  assert.ok(
    Exit.isFailure(await Effect.runPromiseExit(operation)),
    "An unsupported account/model selection must fail.",
  );
}

try {
  await runCauseEffect(service.initialize());
  await waitForCatalog(added.id);
  assert.deepEqual(modelIds(DEFAULT_PROVIDER_ACCOUNT_ID), [PRIMARY, SHARED].sort());
  assert.deepEqual(modelIds(added.id), [ADDED, SHARED].sort());
  assert.deepEqual(
    service
      .listModels()
      .filter((model) => model.provider === "antigravity")
      .map((model) => model.id)
      .sort(),
    [PRIMARY, SHARED].sort(),
  );
  checks.push("Local catalog retains each account's models; the released catalog stays primary-only.");

  const before = await requests();
  for (let index = 0; index < 20; index += 1) service.listLocalModels();
  assert.deepEqual(await requests(), before);
  checks.push("Reading cached account models starts no process or model probe.");

  const agent = await runCauseEffect(
    service.createAgentProfile({
      name: "Model account fixture",
      description: "",
      avatarSeed: "fixture",
      avatarHue: null,
      provider: "antigravity",
      model: SHARED,
    }),
  );
  const identity = { id: agent.id, threadId: agent.threadId, workspacePath: agent.workspacePath };
  await refused(
    service.createAgentProfile({
      name: "Refused default",
      description: "",
      avatarSeed: "refused",
      avatarHue: null,
      provider: "antigravity",
      model: ADDED,
    }),
  );
  await refused(service.updateAgent({ agentId: agent.id, provider: "antigravity", model: ADDED }));
  await runCauseEffect(
    service.updateAgent({ agentId: agent.id, provider: "antigravity", model: ADDED, providerAccountId: added.id }),
  );
  await refused(
    service.updateAgent({ agentId: agent.id, provider: "antigravity", model: PRIMARY, providerAccountId: added.id }),
  );
  await runCauseEffect(
    service.updateAgent({
      agentId: agent.id,
      backupModels: {
        automatic: true,
        order: [{ provider: "antigravity", model: ADDED, providerAccountId: added.id }],
      },
    }),
  );
  await refused(
    service.updateAgent({
      agentId: agent.id,
      backupModels: {
        automatic: true,
        order: [{ provider: "antigravity", model: ADDED, providerAccountId: DEFAULT_PROVIDER_ACCOUNT_ID }],
      },
    }),
  );
  let stored = service.listAgents().find((item) => item.id === agent.id);
  assert.ok(stored);
  assert.deepEqual({ id: stored.id, threadId: stored.threadId, workspacePath: stored.workspacePath }, identity);
  assert.equal(stored.model, ADDED);
  assert.equal(stored.providerAccountId, added.id);
  assert.equal(service.preferredProvider(), "codex");
  checks.push(
    "Creation, model switches and backup selections reject the wrong account without changing identity or defaults.",
  );

  const common = await runCauseEffect(
    service.createAgentProfile({
      name: "Common first",
      description: "",
      avatarSeed: "common",
      avatarHue: null,
      provider: "antigravity",
      model: SHARED,
    }),
  );
  await runCauseEffect(service.updateAgent({ agentId: common.id, providerAccountId: added.id }));
  const assignments = () =>
    service.listAgents().map((item) => ({
      id: item.id,
      threadId: item.threadId,
      model: item.model,
      providerAccountId: item.providerAccountId,
      pendingRuntime: item.pendingRuntime,
    }));
  const beforeRemoval = assignments();
  assert.equal(
    beforeRemoval[0]?.id,
    common.id,
    "The first affected agent has a model that the default account accepts.",
  );
  await refused(service.removeProviderAccount("antigravity", added.id));
  assert.deepEqual(assignments(), beforeRemoval);
  assert.ok(accounts.get("antigravity", added.id));
  await runCauseEffect(service.updateAgent({ agentId: agent.id, model: SHARED }));
  const queuedAgent = await runCauseEffect(
    service.createAgentProfile({
      name: "Queued fixture",
      description: "",
      avatarSeed: "queued",
      avatarHue: null,
      provider: "antigravity",
      model: SHARED,
    }),
  );
  await runCauseEffect(
    store.updateAgent({
      agentId: queuedAgent.id,
      pendingRuntime: { provider: "antigravity", model: ADDED, providerAccountId: added.id, reasoningEffort: "medium" },
    }),
  );
  const beforeQueuedRemoval = assignments();
  await refused(service.removeProviderAccount("antigravity", added.id));
  assert.deepEqual(assignments(), beforeQueuedRemoval);
  assert.ok(accounts.get("antigravity", added.id));
  await runCauseEffect(store.updateAgent({ agentId: queuedAgent.id, pendingRuntime: null }));
  await runCauseEffect(service.updateAgent({ agentId: agent.id, model: ADDED }));
  checks.push("Removing an account preflights all current and queued selections before any assignment changes.");

  await writeFile(modelsPath, JSON.stringify([SHARED]));
  await runCauseEffect(service.signInProviderAccountOnHost("antigravity", added.id, async () => {}));
  await waitForCatalog(added.id, false);
  stored = service.listAgents().find((item) => item.id === agent.id);
  assert.equal(stored?.model, ADDED);
  assert.equal(stored?.providerAccountId, added.id);
  checks.push("A changed account catalog does not reset an existing agent's selected model.");

  await runCauseEffect(
    service.updateAgent({ agentId: agent.id, model: SHARED, providerAccountId: added.id, backupModels: null }),
  );
  await runCauseEffect(service.removeProviderAccount("antigravity", added.id));
  assert.ok(!service.listLocalModels().some((model) => model.providerAccountIds?.includes(added.id)));
  assert.equal(await readFile(join(defaultHome, "antigravity-acp", "acp_token.json"), "utf8"), defaultToken);
  stored = service.listAgents().find((item) => item.id === agent.id);
  assert.ok(stored);
  assert.deepEqual({ id: stored.id, threadId: stored.threadId, workspacePath: stored.workspacePath }, identity);
  assert.equal(stored.model, SHARED);
  assert.equal(stored.providerAccountId, undefined);
  await writeFile(modelsPath, JSON.stringify([SHARED, ADDED]));
  await runCauseEffect(service.signInProviderAccountOnHost("antigravity", null, async () => {}));
  const readded = accounts.list("antigravity")[0];
  assert.ok(readded);
  await waitForCatalog(readded.id);
  assert.deepEqual(modelIds(readded.id), [ADDED, SHARED].sort());
  assert.ok(!service.listLocalModels().some((model) => model.providerAccountIds?.includes(added.id)));
  checks.push(
    "Removal clears the account inventory, preserves primary credentials and agent identity, and re-add discovers models again.",
  );
  assert.ok(
    (await requests()).filter((entry) => entry.method === "session/prompt").every((entry) => entry.text === "/usage"),
  );
  passed = true;
} finally {
  await runCauseEffect(service.stop());
  database.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
logger.info("Provider account model checks finished.", { passed, checks: checks.length });
