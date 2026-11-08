// Real ACP children and local HTTP servers verify Gemini routing without a vendor API or model call.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GeminiProxySettings } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderAccountStore } from "../src/backend/agent/provider-account-store";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import type { AgentClient } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import { type AgentCliInfo, ANTIGRAVITY_MANIFEST } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { geminiProxyEnvironment } from "../src/backend/gemini-proxy-environment";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { decodeModelListResponse, decodeRecordResponse, getRecord, getString } from "../src/backend/protocol";
import {
  BUILT_IN_PROVIDER_DRIVERS,
  NO_PROVIDER_CREDENTIALS,
  requireProviderDriver,
} from "../src/backend/provider-drivers";

const execFileAsync = promisify(execFile);
const output = resolve(".openbot-build/gemini-proxy-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-gemini-proxy-"));
const logPath = join(root, "processes.jsonl");
const approvePath = join(root, "approve");
const defaultHome = join(root, "default-home");
const proxyVariables = ["HTTP", "HTTPS", "ALL", "WS", "WSS", "GRPC"].flatMap((name) => [
  `${name}_PROXY`,
  `${name.toLowerCase()}_proxy`,
]);
const bypassVariables = ["NO_PROXY", "no_proxy", "NO_GRPC_PROXY", "no_grpc_proxy"];
const environmentNames = [
  ...proxyVariables,
  ...bypassVariables,
  "SOCKS_PROXY",
  "socks_proxy",
  "GEMINI_HOME",
  "FAKE_PROXY_LOG",
  "FAKE_PROXY_APPROVE",
  "FAKE_PROXY_DIRECT",
  "FAKE_PROXY_NETWORK",
];
const savedEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
const schema = z.object({
  pid: z.number(),
  event: z.string(),
  home: z.string(),
  keyPresent: z.boolean(),
  proxies: z.record(z.string(), z.string().nullable()),
  network: z.object({ external: z.string(), local: z.string(), socks: z.null() }).optional(),
});
type LogEntry = z.infer<typeof schema>;
const requests: Array<{ proxy: string; url: string }> = [];
const proxyOne = createServer((request, response) => {
  requests.push({ proxy: "one", url: request.url ?? "" });
  response.end("proxy-one");
});
const proxyTwo = createServer((request, response) => {
  requests.push({ proxy: "two", url: request.url ?? "" });
  response.end("proxy-two");
});
const direct = createServer((_request, response) => response.end("local-harness"));

const pythonProbe = `import json, os, urllib.request
with urllib.request.urlopen("http://gemini-fixture.invalid/catalog", timeout=3) as response:
    external = response.read().decode()
with urllib.request.urlopen(os.environ["FAKE_PROXY_DIRECT"], timeout=3) as response:
    local = response.read().decode()
print(json.dumps({"external":external,"local":local,"socks":urllib.request.getproxies().get("socks")}))`;

const fakeAcp = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const NL = String.fromCharCode(10), home = process.env.GEMINI_HOME;
const token = path.join(home, "antigravity-acp", "acp_token.json");
const names = ${JSON.stringify([...proxyVariables, ...bypassVariables])};
const log = (event, extra={}) => fs.appendFileSync(process.env.FAKE_PROXY_LOG, JSON.stringify({
  pid:process.pid,event,home,keyPresent:Boolean(process.env.GEMINI_API_KEY),
  proxies:Object.fromEntries(names.map(name=>[name,process.env[name]??null])),...extra
})+NL);
log("start");
let authenticated = false;
const write = message => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message})+NL);
function handle(message) {
  if (message.id === undefined) return;
  log(message.method);
  switch(message.method) {
    case "initialize": {
      if(process.env.FAKE_PROXY_NETWORK === "1") {
        const network=JSON.parse(cp.execFileSync("python3",["-c",${JSON.stringify(pythonProbe)}],{encoding:"utf8",timeout:5000}));
        log("network",{network});
      }
      return write({id:message.id,result:{protocolVersion:1,agentCapabilities:{auth:{logout:{}}},authMethods:[{id:"oauth-personal",name:"Google"},{id:"gemini-api-key",name:"Key"}]}});
    }
    case "logout": fs.rmSync(token,{force:true}); return write({id:message.id,result:{}});
    case "authenticate": {
      if(message.params.methodId === "gemini-api-key") {authenticated=Boolean(process.env.GEMINI_API_KEY);return write({id:message.id,result:{}});}
      process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=proxy-fixture&state=fixture"+NL);
      const wait=setInterval(()=>{
        if(!fs.existsSync(process.env.FAKE_PROXY_APPROVE))return;
        clearInterval(wait);fs.rmSync(process.env.FAKE_PROXY_APPROVE);fs.mkdirSync(path.dirname(token),{recursive:true});fs.writeFileSync(token,"fixture");write({id:message.id,result:{}});
      },10);return;
    }
    case "session/new": {
      if(!authenticated&&!fs.existsSync(token))return write({id:message.id,error:{code:-32000,message:"Authentication required"}});
      return write({id:message.id,result:{sessionId:"s-"+message.id,models:{availableModels:[{modelId:"gemini-fixture",name:"Gemini Fixture"}],currentModelId:"gemini-fixture"}}});
    }
    case "session/prompt": return write({id:message.id,result:{stopReason:"end_turn"}});
    default:return write({id:message.id,result:{}});
  }
}
let buffer="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf(NL))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())handle(JSON.parse(line));}});
process.stdin.on("end",()=>process.exit(0));
`;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (server.listening)
    await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
}

async function entries(): Promise<LogEntry[]> {
  return (await readFile(logPath, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("The proxy fixture did not reach its expected state.");
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}

function assertProxy(entry: LogEntry, url: string): void {
  for (const name of proxyVariables) assert.equal(entry.proxies[name], url, `${entry.event}: ${name}`);
  for (const name of bypassVariables) {
    const hosts = entry.proxies[name]?.split(",");
    assert.ok(hosts);
    assert.ok(hosts.includes("localhost") && hosts.includes("127.0.0.1") && hosts.includes("::1"));
    assert.ok(hosts.every((host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)));
  }
}

let proxy: GeminiProxySettings = { enabled: false, proxyUrl: "http://127.0.0.1:7897" };
let settingsReadable = true;
const credentials = {
  ...NO_PROVIDER_CREDENTIALS,
  apiKey: (provider: string) => (provider === "antigravity" ? "fixture-gemini-key" : null),
  geminiProxySettings: () => {
    if (!settingsReadable) throw new Error("Fixture Gemini proxy settings are unreadable.");
    return proxy;
  },
};
const database = new OpenBotDatabase(join(root, "profile"));
const agents = new AgentStore(join(root, "profile"), join(root, "workspaces"), database);
const clients: AgentClient[] = [];
let runtime: ProviderRuntime | undefined;
const checks: string[] = [];
let passed = false;

try {
  const first = `http://127.0.0.1:${await listen(proxyOne)}`;
  const second = `http://127.0.0.1:${await listen(proxyTwo)}`;
  process.env.FAKE_PROXY_DIRECT = `http://127.0.0.1:${await listen(direct)}/harness`;
  for (const name of proxyVariables) process.env[name] = "socks5://127.0.0.1:9";
  for (const name of bypassVariables) process.env[name] = "*";
  process.env.SOCKS_PROXY = "socks5://127.0.0.1:9";
  process.env.socks_proxy = "socks5://127.0.0.1:9";
  process.env.GEMINI_HOME = defaultHome;
  process.env.FAKE_PROXY_LOG = logPath;
  process.env.FAKE_PROXY_APPROVE = approvePath;
  process.env.FAKE_PROXY_NETWORK = "1";
  proxy = { enabled: true, proxyUrl: first };
  await mkdir(join(defaultHome, "antigravity-acp"), { recursive: true });
  await writeFile(join(defaultHome, "antigravity-acp", "acp_token.json"), "fixture");
  const executable = join(root, "runtime", "bin", "agy_acp_server");
  await mkdir(join(root, "runtime", "bin"), { recursive: true });
  await writeFile(join(root, "runtime", ANTIGRAVITY_MANIFEST), JSON.stringify({ version: "1.4.5" }));
  await writeFile(executable, fakeAcp);
  await chmod(executable, 0o755);
  const cli: AgentCliInfo = { executable, version: "1.4.5", source: "managed" };

  const driver = requireProviderDriver("antigravity");
  const normal = driver.createClient(cli, 10_000, {
    ...credentials,
    agentEnvironment: () => ({ http_proxy: "http://127.0.0.1:9", no_proxy: "*" }),
  });
  clients.push(normal);
  normal.start();
  await runCauseEffect(normal.request("model/list", {}, decodeModelListResponse));
  const thread = await runCauseEffect(
    normal.request("thread/start", { cwd: root, model: "gemini-fixture" }, decodeRecordResponse),
  );
  assert.ok(getString(getRecord(thread, "thread"), "id"));
  assert.ok(driver.createProfileClient);
  const profile = driver.createProfileClient(cli, 10_000, credentials);
  clients.push(profile);
  profile.start();
  await runCauseEffect(profile.request("model/list", {}, decodeModelListResponse));
  const initial = await entries();
  const network = initial.filter((entry) => entry.event === "network");
  assert.ok(network.length >= 3, "Discovery, per-session and profile clients all spawn with the proxy.");
  for (const entry of initial) assertProxy(entry, first);
  for (const entry of network)
    assert.deepEqual(entry.network, { external: "proxy-one", local: "local-harness", socks: null });
  checks.push(
    "Default, per-session and profile ACP processes route external HTTP through the proxy and keep the local harness direct.",
  );

  const accounts = new ProviderAccountStore(join(root, "accounts.json"), join(root, "accounts"));
  await runCauseEffect(accounts.load());
  await runCauseEffect(agents.initialize());
  runtime = new ProviderRuntime({
    offProviders: BUILT_IN_PROVIDER_DRIVERS.map((item) => item.id).filter((id) => id !== "antigravity"),
    conversation: new ConversationRuntime(
      agents,
      () => undefined,
      () => agents.list(),
    ),
    hooks: {
      bindClient: () => undefined,
      onProvidersReady: () => Effect.void,
      onProviderLost: () => undefined,
      onClientStopped: () => Effect.void,
      isStopping: () => false,
      isProviderBusy: () => false,
      isAgentBusy: () => false,
      isProviderAssigned: () => true,
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: 10_000,
    preferredProvider: "antigravity",
    clientFactory: null,
    bundledExecutables: { antigravity: executable },
    credentials,
    accounts,
    redactMcp: (text) => text,
  });
  const activeRuntime = runtime;
  await runCauseEffect(runtime.ensureProvider("antigravity"));
  const approve = async () => {
    await writeFile(approvePath, "approved");
  };
  const beforeLogin = (await entries()).length;
  await runCauseEffect(runtime.signInProviderOnHost("antigravity", approve));
  await runCauseEffect(runtime.signInProviderAccountOnHost("antigravity", null, approve));
  const [account] = accounts.list("antigravity");
  assert.ok(account);
  const accountHome = accounts.home(account);
  const logins = (await entries()).slice(beforeLogin);
  assert.ok(logins.some((entry) => entry.home === defaultHome && entry.event === "authenticate"));
  assert.ok(logins.some((entry) => entry.home === accountHome && entry.event === "authenticate"));
  assert.ok(logins.some((entry) => entry.home === accountHome && entry.event === "session/prompt"));
  for (const entry of logins) assertProxy(entry, first);
  assert.ok(logins.filter((entry) => entry.home === accountHome).every((entry) => !entry.keyPresent));
  checks.push(
    "Default and added-account OAuth, model discovery and usage receive the proxy without changing the account home or leaking its saved API key.",
  );

  const created = await runCauseEffect(
    agents.createAgent({ name: "Proxy account", description: "", avatarSeed: "proxy", avatarHue: null }),
  );
  const agent = { ...created, provider: "antigravity" as const, providerAccountId: account.id };
  const previousClient = await runCauseEffect(runtime.ensureAgentClient(agent));
  const shared = runtime.currentClient("antigravity");
  proxy = { enabled: true, proxyUrl: second };
  const replaced = await runCauseEffect(runtime.ensureAgentClient(agent));
  assert.notEqual(replaced, previousClient);
  assert.equal(
    runtime.currentClient("antigravity"),
    shared,
    "The proxy fingerprint replaces an account client even without an activation change.",
  );
  await runCauseEffect(runtime.restartProviderWhenIdle("antigravity"));
  await waitFor(
    async () =>
      (await entries()).some(
        (entry) =>
          entry.home === accountHome && entry.event === "session/prompt" && entry.proxies.HTTP_PROXY === second,
      ) &&
      activeRuntime
        .status()
        .providers?.find((row) => row.id === "antigravity")
        ?.accounts?.find((row) => row.id === account.id)?.state === "connected",
  );
  checks.push(
    "Changing the proxy replaces held account clients and refreshes recent account metadata without an identity or credential reset.",
  );

  process.env.FAKE_PROXY_NETWORK = "0";
  proxy = { enabled: false, proxyUrl: second };
  const beforeDisabled = (await entries()).length;
  const disabled = driver.createClient(cli, 10_000, credentials);
  clients.push(disabled);
  disabled.start();
  await runCauseEffect(disabled.request("model/list", {}, decodeModelListResponse));
  const disabledEntry = (await entries()).slice(beforeDisabled).find((entry) => entry.event === "start");
  assert.ok(disabledEntry);
  assert.equal(disabledEntry.proxies.HTTPS_PROXY, "socks5://127.0.0.1:9");
  assert.equal(disabledEntry.proxies.NO_PROXY, "*");
  proxy = { enabled: true, proxyUrl: first };
  settingsReadable = false;
  const beforeUnreadable = (await entries()).filter((entry) => entry.event === "start").length;
  const refused = driver.createClient(cli, 10_000, credentials);
  clients.push(refused);
  assert.throws(() => refused.start(), /proxy settings are unreadable/u);
  await assert.rejects(
    runCauseEffect(runtime.signInProviderOnHost("antigravity", approve)),
    /proxy settings are unreadable/u,
  );
  await assert.rejects(
    runCauseEffect(runtime.signInProviderAccountOnHost("antigravity", account.id, approve)),
    /proxy settings are unreadable/u,
  );
  assert.equal(
    (await entries()).filter((entry) => entry.event === "start").length,
    beforeUnreadable,
    "Unreadable settings start no Gemini client or sign-in process.",
  );
  const beforeOther = (await entries()).length;
  const other = requireProviderDriver("opencode").createClient(cli, 10_000, credentials);
  clients.push(other);
  other.start();
  await runCauseEffect(other.request("model/list", {}, decodeModelListResponse));
  const otherEntry = (await entries()).slice(beforeOther).find((entry) => entry.event === "start");
  assert.ok(otherEntry);
  assert.equal(otherEntry.proxies.HTTPS_PROXY, "socks5://127.0.0.1:9");
  assert.equal(otherEntry.proxies.NO_PROXY, "*");
  settingsReadable = true;
  checks.push(
    "Disabling restores inherited routing; unreadable settings block Gemini clients and both sign-in paths while another ACP provider still works unchanged.",
  );

  await close(proxyTwo);
  const failed = await execFileAsync(
    "python3",
    [
      "-c",
      `import json,urllib.request,urllib.error
try:
    urllib.request.urlopen("http://gemini-fixture.invalid/catalog",timeout=3)
    raise SystemExit("A stopped proxy unexpectedly succeeded")
except urllib.error.URLError as error:
    print(json.dumps({"refused":getattr(error.reason,"errno",None) in (61,111,10061)}))`,
    ],
    { env: { ...process.env, ...geminiProxyEnvironment({ enabled: true, proxyUrl: second }) }, timeout: 5_000 },
  );
  assert.equal(z.object({ refused: z.boolean() }).parse(JSON.parse(failed.stdout)).refused, true);
  assert.ok(
    requests.every((request) => request.url === "http://gemini-fixture.invalid/catalog"),
    "No loopback harness request reaches either proxy.",
  );
  checks.push("An unreachable configured proxy fails with connection refusal rather than a direct network fallback.");
  passed = true;
} finally {
  if (runtime) for (const client of await runCauseEffect(runtime.dispose())) await runCauseEffect(client.stop());
  for (const client of clients) await runCauseEffect(client.stop());
  database.close();
  for (const server of [proxyOne, proxyTwo, direct]) await close(server);
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, proxiedRequests: requests.length }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
}
