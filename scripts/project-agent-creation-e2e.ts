// Real AgentService and file ownership with a local fake Codex process. No vendor model is called.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentLifecycleFailed, AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";

const logger = createOpenBotLogger("project-agent-creation-e2e");
const output = resolve(".openbot-build/project-agent-creation-e2e");
const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-project-create-")));
const profile = join(root, "profile");
const files = join(root, "files");
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
const fake = join(root, "fake-codex");
const logPath = join(root, "codex.jsonl");
const previousOverride = process.env.OPENBOT_CODEX_PATH;
const checks: string[] = [];
const preparations: { id: string; name: string; cwd: string; managed: boolean }[] = [];
let database: OpenBotDatabase | null = null;
let service: AgentService | null = null;
let passed = false;

const unavailable = () => Effect.die(new Error("This fixture uses no browser operation."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unavailable,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unavailable,
  resolveUploadTarget: unavailable,
  handleDynamicTool: unavailable,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const eventSchema = z.object({
  method: z.string(),
  threadId: z.string(),
  cwd: z.string(),
  text: z.string().optional(),
});
function events(): z.infer<typeof eventSchema>[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => eventSchema.parse(JSON.parse(line)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function waitFor<T>(name: string, inspect: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = inspect();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}.`);
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}
const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.166.0\\n");process.exit(0); }
const logPath = ${JSON.stringify(logPath)};
const config = { config: {mcp_servers:{}}, layers:[{name:{type:"user",file:${JSON.stringify(join(root, "fake-config.toml"))},profile:null},version:"1",config:{mcp_servers:{}}}] };
let input="", nextThread=0, nextTurn=0;
const threads = new Map();
const write = value => process.stdout.write(JSON.stringify(value)+"\\n");
const log = value => fs.appendFileSync(logPath,JSON.stringify(value)+"\\n");
function handle(message) {
 if(message.id===undefined)return;
 const p=message.params||{};
 switch(message.method) {
  case "initialize": return write({id:message.id,result:{}});
  case "account/read": return write({id:message.id,result:{account:{type:"chatgpt",email:"fixture@example.test"}}});
  case "account/rateLimits/read": return write({id:message.id,result:{rateLimits:{limitId:"codex",primary:null,secondary:null},rateLimitsByLimitId:null}});
  case "model/list": return write({id:message.id,result:{data:[{model:"gpt-6-luna",displayName:"GPT-6 Luna"}]}});
  case "plugin/list": return write({id:message.id,result:{marketplaces:[]}});
  case "config/read": return write({id:message.id,result:config});
  case "config/batchWrite": return write({id:message.id,result:{}});
  case "thread/start": {
   const id="project-thread-"+(++nextThread),cwd=String(p.cwd||"");threads.set(id,{cwd});log({method:message.method,threadId:id,cwd});
   return write({id:message.id,result:{thread:{id,turns:[]}}});
  }
  case "thread/resume": {
   const cwd=String(p.cwd||threads.get(p.threadId)?.cwd||"");threads.set(p.threadId,{cwd});log({method:message.method,threadId:p.threadId,cwd});
   return write({id:message.id,result:{thread:{id:p.threadId,turns:[]}}});
  }
  case "thread/unsubscribe": return write({id:message.id,result:{status:"Unsubscribed"}});
  case "thread/turns/list": case "thread/items/list": return write({id:message.id,result:{data:[],nextCursor:null}});
  case "thread/read": return write({id:message.id,result:{thread:{id:p.threadId,turns:[]}}});
  case "turn/start": {
   const id="project-turn-"+(++nextTurn),cwd=threads.get(p.threadId)?.cwd||"",text=(p.input||[]).map(v=>v.text||"").join("\\n");
   log({method:message.method,threadId:p.threadId,cwd,text});
   write({id:message.id,result:{turn:{id,status:"inProgress",items:[]}}});
   write({method:"turn/started",params:{threadId:p.threadId,turn:{id}}});
   write({method:"item/completed",params:{threadId:p.threadId,turnId:id,item:{type:"agentMessage",id:"answer-"+id,text:"Workspace fixture complete.",phase:"final_answer"}}});
   return write({method:"turn/completed",params:{threadId:p.threadId,turn:{id,status:"completed"}}});
  }
  default:return write({id:message.id,result:{}});
 }
}
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;let end;while((end=input.indexOf("\\n"))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(line.trim())handle(JSON.parse(line));}});
process.stdin.on("end",()=>process.exit(0));process.stdout.on("error",()=>process.exit(0));
`;

try {
  await mkdir(files, { recursive: true });
  await mkdir(projectA);
  await mkdir(projectB);
  const skillPath = join(projectA, ".agents", "skills", "fixture-only", "SKILL.md");
  await mkdir(join(projectA, ".agents", "skills", "fixture-only"), { recursive: true });
  await writeFile(skillPath, "");
  const skillBefore = await stat(skillPath, { bigint: true });
  await writeFile(join(projectA, "AGENTS.md"), "Synthetic project instructions; preserve these files.\n");
  await writeFile(join(projectA, "sentinel.txt"), "project-a-retained");
  await writeFile(join(projectB, "sentinel.txt"), "project-b-retained");
  const instructionsBefore = await readFile(join(projectA, "AGENTS.md"), "utf8");
  await writeFile(fake, fakeCodex, { mode: 0o755 });
  process.env.OPENBOT_CODEX_PATH = fake;
  database = new OpenBotDatabase(profile);
  const store = new AgentStore(profile, files, database);
  const mailbox = new MailboxStore(profile, store.sharedRoot, database);
  service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    credentials: NO_PROVIDER_CREDENTIALS,
    bundledExecutables: { codex: fake },
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    prepareAgentWorkspace: (agent) =>
      Effect.gen(function* () {
        preparations.push({
          id: agent.id,
          name: agent.name,
          cwd: agent.workspacePath,
          managed: store.isManagedWorkspace(agent.id),
        });
        if (agent.name === "Fail preparation")
          return yield* new AgentLifecycleFailed({
            operation: "fixture preparation",
            cause: new Error("fixture preparation failed"),
          });
        if (store.isManagedWorkspace(agent.id))
          yield* Effect.promise(() => writeFile(join(agent.workspacePath, "managed-setup.txt"), "managed-only"));
      }),
  });
  const agents = service;
  await runCauseEffect(agents.initialize());
  const input = (name: string, text: string) => ({
    name,
    description: "Synthetic project creation fixture",
    avatarSeed: "project-fixture",
    avatarHue: null,
    initialMessage: text,
  });
  const create = (name: string, text: string, path: string) =>
    runCauseEffect(agents.createAgent(input(name, text), undefined, undefined, undefined, path));
  const settled = (id: string) =>
    waitFor("initial delivery completion", () =>
      agents.listQueue(id).deliveries.find((entry) => entry.status === "completed" || entry.status === "failed"),
    );
  const first = await create("Project first", "FIRST-PROJECT-FIXTURE", projectA);
  const firstDelivery = await settled(first.id);
  assert.equal(firstDelivery.status, "completed");
  const firstTurn = await waitFor("first project turn", () =>
    events().find((entry) => entry.method === "turn/start" && entry.text?.includes("FIRST-PROJECT-FIXTURE")),
  );
  assert.equal(first.workspacePath, projectA);
  assert.equal(firstTurn.cwd, projectA);
  const prepared = preparations.find((entry) => entry.id === first.id);
  assert.ok(prepared);
  assert.equal(prepared.cwd, projectA);
  assert.equal(prepared.managed, false);
  assert.equal(store.isManagedWorkspace(first.id), false);
  await assert.rejects(access(join(projectA, "managed-setup.txt")));
  assert.equal(await readFile(join(projectA, "AGENTS.md"), "utf8"), instructionsBefore);
  checks.push(
    "Project binding precedes preparation and the initial fake-provider turn; automatic managed setup does not write into the selected project.",
  );

  const second = await create("Project second", "SECOND-SHARED-PROJECT-FIXTURE", projectA);
  assert.equal((await settled(second.id)).status, "completed");
  const secondTurn = await waitFor("second shared-project turn", () =>
    events().find((entry) => entry.method === "turn/start" && entry.text?.includes("SECOND-SHARED-PROJECT-FIXTURE")),
  );
  assert.equal(secondTurn.cwd, projectA);
  assert.equal(second.workspacePath, first.workspacePath);
  assert.notEqual(second.id, first.id);
  const channelStore = new ChannelStore(database);
  const channelOperationId = randomUUID();
  const channel = channelStore.create(channelOperationId, {
    name: "Shared project",
    title: "",
    instructions: "",
    leadAgentId: first.id,
    members: [{ agentId: first.id }, { agentId: second.id }],
  });
  channelStore.commit(channelOperationId, { channel, messages: [], tasks: [], assignments: [] });
  assert.deepEqual(
    channelStore.get(channel.id).members.map((member) => member.agentId),
    [first.id, second.id],
  );
  checks.push(
    "Two assistants can explicitly share the exact same external project and join one durable channel without sharing public identity.",
  );

  const firstThread = store.list().find((entry) => entry.id === first.id)?.threadId;
  assert.ok(firstThread);
  const startsBeforeSameProject = events().filter((entry) => entry.method === "thread/start").length;
  const updatedBeforeSameProject = store.list().find((entry) => entry.id === first.id)?.updatedAt;
  await runCauseEffect(agents.setAgentWorkspace(first.id, projectA));
  assert.equal(store.list().find((entry) => entry.id === first.id)?.updatedAt, updatedBeforeSameProject);
  const sameReceipt = await runCauseEffect(agents.sendMessage({ agentId: first.id, text: "SAME-PROJECT-FIXTURE" }));
  const sameId = sameReceipt.deliveries[0]?.id;
  assert.ok(sameId);
  assert.equal(
    await waitFor("same project completion", () => {
      const status = mailbox.getDelivery(sameId)?.delivery.status;
      return status === "completed" || status === "failed" ? status : null;
    }),
    "completed",
  );
  const sameTurn = events().find(
    (entry) => entry.method === "turn/start" && entry.text?.includes("SAME-PROJECT-FIXTURE"),
  );
  assert.equal(sameTurn?.threadId, firstTurn.threadId);
  assert.equal(events().filter((entry) => entry.method === "thread/start").length, startsBeforeSameProject);
  checks.push("Selecting the current project again preserves saved metadata and the loaded provider session.");
  await runCauseEffect(agents.setAgentWorkspace(first.id, projectB));
  assert.equal(store.list().find((entry) => entry.id === first.id)?.threadId, firstThread);
  const switchedReceipt = await runCauseEffect(
    agents.sendMessage({ agentId: first.id, text: "AFTER-PROJECT-SWITCH-FIXTURE" }),
  );
  const switchedId = switchedReceipt.deliveries[0]?.id;
  assert.ok(switchedId);
  const switched = await waitFor("switched project completion", () => {
    const status = mailbox.getDelivery(switchedId)?.delivery.status;
    return status === "completed" || status === "failed" ? status : null;
  });
  assert.equal(switched, "completed");
  const afterSwitch = events().find(
    (entry) => entry.method === "turn/start" && entry.text?.includes("AFTER-PROJECT-SWITCH-FIXTURE"),
  );
  assert.ok(afterSwitch);
  assert.equal(afterSwitch.cwd, projectB);
  assert.equal((await runCauseEffect(agents.getAgentWorkspace(second.id))).path, projectA);
  checks.push(
    "Changing one assistant's project changes its next provider working directory while preserving public chat identity and the other assistant's binding.",
  );

  const countBeforeFailures = store.list().length;
  await assert.rejects(create("Fail preparation", "MUST-NOT-SEND-FAILED-PREPARATION", projectA));
  await assert.rejects(
    runCauseEffect(
      agents.createAgent(
        { ...input("Fail model", "MUST-NOT-SEND-FAILED-MODEL"), model: "missing-project-fixture-model" },
        undefined,
        undefined,
        undefined,
        projectA,
      ),
    ),
  );
  await assert.rejects(create("Missing project", "MUST-NOT-SEND-MISSING-PROJECT", join(root, "missing-project")));
  assert.equal(store.list().length, countBeforeFailures);
  assert.equal(
    events().some((entry) => entry.method === "turn/start" && entry.text?.includes("MUST-NOT-SEND")),
    false,
  );
  assert.equal(await readFile(join(projectA, "sentinel.txt"), "utf8"), "project-a-retained");
  assert.equal(await readFile(join(projectB, "sentinel.txt"), "utf8"), "project-b-retained");
  checks.push(
    "Preparation, model and missing-directory creation failures roll back only the new assistant and never send its initial message or delete project files.",
  );

  await runCauseEffect(agents.deleteAgent(second.id));
  assert.equal(await readFile(join(projectA, "sentinel.txt"), "utf8"), "project-a-retained");
  await runCauseEffect(agents.setAgentWorkspace(first.id, projectA));
  const restored = await runCauseEffect(agents.setAgentWorkspace(first.id, null));
  assert.equal(restored.custom, false);
  assert.equal(store.isManagedWorkspace(first.id), true);
  assert.equal(await readFile(join(projectA, "AGENTS.md"), "utf8"), instructionsBefore);
  const skillAfter = await stat(skillPath, { bigint: true });
  assert.equal(skillAfter.size, skillBefore.size);
  assert.equal(skillAfter.mtimeNs, skillBefore.mtimeNs);
  assert.equal(await readFile(join(projectB, "sentinel.txt"), "utf8"), "project-b-retained");
  checks.push(
    "Deletion, restoration and shared-project use leave external instructions, Skill metadata and project contents intact.",
  );
  passed = true;
} finally {
  if (service)
    await runCauseEffect(service.stop()).catch(() => {
      passed = false;
    });
  database?.close();
  if (previousOverride === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousOverride;
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, liveProviderUsed: false, realSkillContentRead: false, preparationChecks: preparations.length }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
  logger.info("Project assistant creation checks finished.", { passed, checks: checks.length });
  if (!passed) process.exitCode = 1;
}
