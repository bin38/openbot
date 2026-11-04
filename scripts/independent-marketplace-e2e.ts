// Reads a real HTTP directory fixture, persists a selected configuration and local catalogs, and never starts catalog software.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registryMcpConfig } from "@openbot/contracts/ipc-mcp-registry";
import { Effect } from "effect";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { LocalMarketplaceCatalog } from "../src/main/local-marketplace-catalog";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { type McpRegistryFetch, McpRegistryService, parseMcpRegistryResponse } from "../src/main/mcp-registry-service";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const directory = await mkdtemp(join(tmpdir(), "independent-marketplace-"));
const output = resolve(".openbot-build/independent-marketplace-e2e");
const checks: string[] = [];
const database = new OpenBotDatabase(directory);
let requests = 0;
let unavailable = false;
const observedQueries: string[] = [];
const fixture = {
  servers: [
    {
      server: {
        name: "org.example/http",
        title: "Example HTTP",
        version: "1.0.0",
        description: "A fixture",
        remotes: [
          {
            type: "streamable-http",
            url: "https://service.example/mcp",
            headers: [
              { name: "Authorization", isRequired: true, isSecret: true, value: "publisher-secret-must-not-be-copied" },
            ],
          },
        ],
      },
    },
    {
      server: {
        name: "org.example/local",
        version: "1.2.3",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/fixture",
            version: "1.2.3",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "API_KEY", isRequired: true, isSecret: true, value: "publisher-secret-must-not-be-copied" },
            ],
          },
        ],
      },
    },
    {
      server: {
        name: "org.example/unsupported",
        version: "1.0.0",
        remotes: [{ type: "sse", url: "https://service.example/sse" }],
        packages: [{ registryType: "npm", identifier: "bad;command", version: "latest", transport: { type: "stdio" } }],
      },
    },
  ],
  metadata: { nextCursor: "next-page" },
};
const server = createServer((request, response) => {
  requests += 1;
  observedQueries.push(request.url ?? "");
  const query = new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("search");
  if (query === "oversized") {
    response.writeHead(200, { "content-type": "application/json" }).end(" ".repeat(3 * 1024 * 1024));
    return;
  }
  if (query === "redirect") {
    response.writeHead(302, { Location: "https://untrusted.example/registry" }).end();
    return;
  }
  if (unavailable) {
    response.writeHead(503).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(fixture));
});
let passed = false;
try {
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request: McpRegistryFetch = (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(target.origin, "https://registry.modelcontextprotocol.io");
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, init);
  };
  const registry = new McpRegistryService(join(directory, "cache"), request);
  const page = await Effect.runPromise(registry.search({ query: "example" }));
  assert.equal(page.servers.length, 3);
  assert.equal(page.servers[2]?.connections.length, 0);
  assert.equal(page.nextCursor, "next-page");
  assert.ok(observedQueries[0]?.includes("search=example") && observedQueries[0]?.includes("version=latest"));
  assert.equal(JSON.stringify(page).includes("publisher-secret"), false);
  await Effect.runPromise(registry.search({ query: "example" }));
  assert.equal(requests, 1);
  unavailable = true;
  assert.equal((await Effect.runPromise(registry.search({ query: "example", refresh: true }))).stale, true);
  await assert.rejects(Effect.runPromise(registry.search({ query: "uncached", refresh: true })));
  unavailable = false;
  await Effect.runPromise(registry.search({ query: "example", cursor: "next-page" }));
  assert.ok(observedQueries.at(-1)?.includes("cursor=next-page"));
  const cache = await readdir(join(directory, "cache"));
  for (const path of cache)
    assert.equal((await readFile(join(directory, "cache", path), "utf8")).includes("publisher-secret"), false);
  await assert.rejects(Effect.runPromise(registry.search({ query: "oversized" })));
  await assert.rejects(Effect.runPromise(registry.search({ query: "redirect" })));
  checks.push(
    "public discovery uses the registry only, supports paging and offline cache, and never copies publisher credentials or executes metadata",
  );

  await Effect.runPromise(database.initialize());
  const mcp = new McpServerStore(database);
  const connection = page.servers[1]?.connections[0];
  assert.ok(connection);
  const config = registryMcpConfig("registry-fixture", connection, { "env:API_KEY": "user-owned-fixture-token" });
  assert.deepEqual(config.args, ["-y", "@example/fixture@1.2.3"]);
  assert.equal(config.id, "");
  assert.equal(config.env[0]?.value, "user-owned-fixture-token");
  const saved = mcp.save({ ...config, enabled: false });
  assert.equal(mcp.listEnabled().length, 0);
  mcp.setEnabled(saved.id, true);
  assert.equal(mcp.listEnabled().length, 1);
  mcp.remove(saved.id);
  assert.equal(mcp.list().length, 0);
  checks.push(
    "reviewed registry metadata uses the existing MCP store; untested configurations remain disabled and can be enabled or removed",
  );

  const rejected = parseMcpRegistryResponse(
    {
      servers: [
        {
          server: {
            name: "org.example/unsafe",
            version: "1.0.0",
            remotes: [
              { type: "streamable-http", url: "https://user:secret@evil.test/mcp" },
              { type: "streamable-http", url: "https://evil.test/mcp?api_key=borrowed" },
            ],
            packages: [
              {
                registryType: "npm",
                identifier: "valid-package",
                version: "1.0.0",
                transport: { type: "stdio" },
                runtimeArguments: [{ value: "--eval" }],
              },
            ],
          },
        },
      ],
    },
    new Date().toISOString(),
  );
  assert.equal(rejected.servers[0]?.connections.length, 0);
  checks.push(
    "credential URLs, package-runner overrides, unpinned packages and unsupported transports cannot be imported silently",
  );

  let remoteCalls = 0;
  const remote = {
    requestAuthorized: () => {
      remoteCalls += 1;
      return Effect.die(new Error("Unexpected upstream request"));
    },
    downloadAuthorized: () => {
      remoteCalls += 1;
      return Effect.die(new Error("Unexpected upstream request"));
    },
    resolveApiUrl: () => {
      throw new Error("Unexpected upstream URL");
    },
  };
  const skills = new SkillMarketplaceService(
    remote,
    () => [],
    () => Effect.void,
    new LocalSkillLibrary(join(directory, "skills"), () => []),
    true,
  );
  assert.deepEqual(await Effect.runPromise(skills.list()), { skills: [], nextCursor: null });
  assert.deepEqual(await Effect.runPromise(skills.listMine()), []);
  await assert.rejects(Effect.runPromise(skills.get("old-upstream-listing")));
  assert.equal(remoteCalls, 0);
  checks.push("an empty local skill library and an unavailable old listing never request an upstream account service");

  const path = join(directory, "catalog.json");
  const catalog = new LocalMarketplaceCatalog(path);
  const preview = {
    agentId: "agent-fixture",
    name: "My local agent",
    title: "Workspace helper",
    description: "An independent agent",
    avatarSeed: "fixture",
    avatarHue: null,
    avatarUrl: null,
    skills: [],
    routines: [],
  };
  const first = await Effect.runPromise(catalog.publishAgent(preview, "productivity", null));
  const revised = await Effect.runPromise(
    catalog.publishAgent({ ...preview, description: "Revised locally" }, "productivity", null, first.listingId),
  );
  assert.equal(revised.listingId, first.listingId);
  assert.equal(revised.version, 2);
  const restored = new LocalMarketplaceCatalog(path);
  assert.equal((await Effect.runPromise(restored.listAgents({}))).items.length, 1);
  const published = await Effect.runPromise(restored.publishTemplate(preview.agentId, preview, null));
  assert.equal((await Effect.runPromise(restored.getTemplate(published.id))).description, preview.description);
  await Effect.runPromise(restored.unpublishTemplate(preview.agentId));
  assert.equal(await Effect.runPromise(restored.ownedTemplate(preview.agentId)), null);
  const prior = await readFile(path, "utf8");
  await writeFile(path, "unreadable original");
  await assert.rejects(Effect.runPromise(restored.publishAgent(preview, "productivity", null)));
  assert.equal(await readFile(path, "utf8"), "unreadable original");
  await writeFile(path, prior);
  checks.push(
    "local agent/template snapshots persist across restart, update without duplicates, unpublish locally and preserve a damaged catalog",
  );
  passed = true;
} finally {
  database.close();
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(directory, { recursive: true, force: true });
}
assert.ok(passed);
process.stdout.write(`Independent marketplace E2E passed. Report: ${join(output, "report.json")}\n`); // Machine-readable: report path for the local verification runner.
