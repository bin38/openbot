// Import JSON, save it in a real temporary SQLite database, and connect to local HTTP and STDIO
// MCP servers. No provider, account, or external service is used.
// bun scripts/mcp-config-import-e2e.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { inspectMcpServer } from "../src/backend/mcp-probe";
import { redactMcpValues } from "../src/backend/mcp-redaction";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import {
  MCP_IMPORT_MAX_BYTES,
  mcpImportDestination,
  parseMcpConfigImport,
} from "../src/renderer/src/features/servers/mcp-config-import";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-config-import-e2e");
const HTTP_TOKEN = "mcp-import-http-e2e-32c1";
const ENV_TOKEN = " mcp-import-env-e2e-18ca ";
const root = await mkdtemp(join(tmpdir(), "openbot-mcp-import-"));
const database = new OpenBotDatabase(root);
const report: { passed: boolean; steps: string[]; failures: string[] } = {
  passed: false,
  steps: [],
  failures: [],
};
let requests = 0;

type FixtureJson = string | number | boolean | null | FixtureJson[] | { [key: string]: FixtureJson | undefined };

function json(response: ServerResponse, status: number, body: FixtureJson): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!request.url?.startsWith("/mcp")) return json(response, 404, {});
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  requests += 1;
  if (request.headers["x-api-key"] !== HTTP_TOKEN) return json(response, 401, {});
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(isDynamicRecord(message));
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  assert.ok(typeof message.id === "string" || typeof message.id === "number");
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-import-e2e", version: "1" },
        }
      : {
          tools: [
            { name: "read_fixture", description: "Read the fixture", inputSchema: { type: "object", properties: {} } },
          ],
        };
  json(response, 200, { jsonrpc: "2.0", id: message.id, result });
}

const server = createServer((request, response) => {
  void handle(request, response).catch(() => response.writeHead(500).end());
});

function one(document: DynamicRecord | McpServerConfig): McpServerConfig {
  const result = parseMcpConfigImport(JSON.stringify(document));
  assert.equal(result.issue, null);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.ok(item?.config, item?.issue ?? "a server config is present");
  return item.config;
}

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  await runCauseEffect(database.initialize());
  const store = new McpServerStore(database);

  const http = one({ mcpServers: { documents: { url, headers: { "x-api-key": HTTP_TOKEN } } } });
  assert.equal(http.id, "");
  assert.equal(store.list().length, 0);
  assert.equal(requests, 0);
  report.steps.push("Preview and cancellation make no connection and save no row");

  const stored = store.save(http);
  const result = await runCauseEffect(inspectMcpServer(stored));
  assert.equal(result.error, null);
  assert.deepEqual(result.tools, ["read_fixture"]);
  report.steps.push("A standard mcpServers import saves and connects with its header credential");

  store.setEnabled(stored.id, false);
  assert.equal(store.listEnabled().length, 0);
  store.setEnabled(stored.id, true);
  assert.equal(store.listEnabled()[0]?.id, stored.id);
  assert.equal((await runCauseEffect(inspectMcpServer(store.listEnabled()[0] ?? stored))).error, null);
  report.steps.push("Disable and re-enable retain the configuration and reconnect");

  const duplicate = one({ ...http, id: stored.id });
  assert.equal(duplicate.id, "");
  assert.throws(() => store.save(duplicate));
  assert.deepEqual(store.get(stored.id), stored);
  const renamed = store.save({ ...duplicate, name: "documents-copy" });
  assert.notEqual(renamed.id, stored.id);
  report.steps.push("Imported IDs cannot overwrite an existing server; renaming creates a new row");

  const mikka = parseMcpConfigImport(
    JSON.stringify({
      servers: [
        {
          id: "remote-id",
          name: "mikka",
          url,
          transport: "http",
          enabled: false,
          revision: 2,
          authKind: "header",
          createdAt: "2026-11-03T00:00:00Z",
        },
      ],
      count: 1,
    }),
  );
  const mikkaItem = mikka.items[0];
  assert.ok(mikkaItem?.config);
  assert.equal(mikkaItem.needsCredentials, true);
  assert.equal(mikkaItem.config.enabled, false);
  const authorized = store.save({ ...mikkaItem.config, headers: [{ key: "x-api-key", value: HTTP_TOKEN }] });
  assert.equal((await runCauseEffect(inspectMcpServer(authorized))).error, null);
  assert.equal(
    store.listEnabled().some((config) => config.id === authorized.id),
    false,
  );
  report.steps.push("A Mikka export retains its disabled state and asks for the omitted credential");

  const fixtureDirectory = join(root, "folder with spaces");
  await mkdir(fixtureDirectory);
  const fixturePath = join(fixtureDirectory, "mcp fixture.mjs");
  await writeFile(
    fixturePath,
    `import { createInterface } from 'node:readline';
if (process.argv[2] !== 'argument with spaces' || process.argv[3] !== ' trailing space ' || process.env.MCP_IMPORT_TOKEN !== ${JSON.stringify(ENV_TOKEN)}) process.exit(17);
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'import-stdio', version: '1' } }
    : { tools: [{ name: 'inspect_fixture', inputSchema: { type: 'object', properties: {} } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  );
  const stdio = one({
    name: "local-fixture",
    command: process.execPath,
    args: [fixturePath, "argument with spaces", " trailing space "],
    env: { MCP_IMPORT_TOKEN: ENV_TOKEN },
    cwd: fixtureDirectory,
  });
  const storedStdio = store.save(stdio);
  const stdioResult = await runCauseEffect(inspectMcpServer(storedStdio));
  assert.equal(stdioResult.error, null);
  assert.deepEqual(stdioResult.tools, ["inspect_fixture"]);
  report.steps.push(
    "A STDIO import launches the real process with exact arguments, environment, and working directory",
  );

  const mixed = parseMcpConfigImport(
    JSON.stringify({
      servers: [
        { name: "old-sse", transport: "sse", url },
        { name: "valid", transport: "http", url },
        { name: "access-rules", command: "node", allowedTools: ["read"] },
        { name: "duplicate-header", url, headers: { Authorization: "first", authorization: "second" } },
        { name: "invalid-process-value", command: "node", args: ["embedded\0nul"] },
      ],
    }),
  );
  assert.equal(mixed.items[0]?.issue, "mcp.import.sseUnsupported");
  assert.ok(mixed.items[1]?.config);
  assert.equal(mixed.items[2]?.issue, "mcp.import.invalidFields");
  assert.equal(mixed.items[3]?.issue, "mcp.import.invalidFields");
  assert.equal(mixed.items[4]?.issue, "mcp.import.invalidFields");
  assert.equal(parseMcpConfigImport('{"token":"secret').issue, "mcp.import.invalidJson");
  assert.equal(parseMcpConfigImport(" ".repeat(MCP_IMPORT_MAX_BYTES + 1)).issue, "mcp.import.tooLarge");
  const secretUrl = one({ name: "private-url", url: `${url}?token=${HTTP_TOKEN}` });
  assert.equal(mcpImportDestination(secretUrl), `127.0.0.1:${address.port}`);
  assert.ok(!JSON.stringify(parseMcpConfigImport(`{"token":"${HTTP_TOKEN}`)).includes(HTTP_TOKEN));
  report.steps.push(
    "Unsupported transports and access settings are explicit; errors and previews do not expose credentials",
  );

  for (const config of store.list()) store.remove(config.id);
  assert.equal(store.list().length, 0);
  report.steps.push("All imported servers can be removed through the existing store");
  report.passed = true;
} catch (error) {
  report.failures.push(
    redactMcpValues(error instanceof Error ? (error.stack ?? error.message) : String(error), [HTTP_TOKEN, ENV_TOKEN]),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

// Machine-readable: the report path and exit status are the script's result.
process.stdout.write(
  `${report.passed ? "PASS" : "FAIL"} ${report.steps.length} steps. Report: ${join(OUT, "report.json")}\n`,
);
if (!report.passed) process.exitCode = 1;
