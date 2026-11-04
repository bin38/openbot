// Verifies network defaults against real loopback services. No account or external service is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { openPanelTransport, safeReport, telemetryEndpoint } from "@openbot/telemetry";
import { Effect } from "effect";
import { GitHubBotTokens } from "../src/main/github-bot-tokens";
import { githubAppConfig, githubAppStorageFile } from "../src/main/github-connector-config";
import { fetchLatestLinuxRelease, HostReleaseService } from "../src/main/host-release-service";
import { fetchBlockedVersions } from "../src/main/provider-runtime-releases";
import { supportsInstalledUpdates } from "../src/main/update-service";

const logger = createOpenBotLogger("independent-network-e2e");
const output = resolve(".openbot-build/independent-network-e2e");
const checks: string[] = [];
let unexpectedRequests = 0;
let reports = 0;
let brokerRequests = 0;
let blocklistRequests = 0;
let feedRequests = 0;
let redirectedReports = 0;
let collectorIdentityValid = false;
let brokerIdentityValid = false;
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const forbiddenFetch: NetworkFetch = async () => {
  unexpectedRequests += 1;
  throw new Error("An unconfigured service tried to use the network.");
};
const server = createServer((request, response) => {
  request.resume();
  if (request.url === "/redirect-collector") {
    response.writeHead(307, { location: "/unexpected-collector" }).end();
    return;
  }
  if (request.url === "/unexpected-collector") {
    redirectedReports += 1;
    response.writeHead(202).end();
    return;
  }
  if (request.url === "/api/track") {
    collectorIdentityValid = request.headers["openpanel-client-id"] === "own-collector";
    reports += 1;
    response.writeHead(202).end();
    return;
  }
  if (request.url === "/v1/github/installation-tokens") {
    brokerIdentityValid = request.headers.authorization === "Bearer fixture-user-token";
    brokerRequests += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        installations: [
          {
            installationId: 1,
            account: "fixture-owner",
            token: "fixture-installation-token",
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            repositories: ["fixture/repository"],
          },
        ],
      }),
    );
    return;
  }
  if (request.url === "/runtime-blocklist.json") {
    blocklistRequests += 1;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ schemaVersion: 1, blocked: { codex: ["9.9.9"] } }));
    return;
  }
  if (request.url === "/broken-blocklist.json") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ invalid: true }));
    return;
  }
  if (request.url === "/releases/latest-mac.yml") {
    feedRequests += 1;
    response
      .writeHead(200, { "content-type": "text/yaml" })
      .end("version: 9.9.9\nfiles:\n  - url: OpenBot-9.9.9-arm64.zip\n");
    return;
  }
  response.writeHead(404).end();
});

let passed = false;
try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const report = safeReport({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    profileId: null,
    name: "notification_shown",
    surface: "desktop",
    platform: "darwin",
    app_version: "0.59.0",
    event_schema_version: 12,
    properties: {
      operation: "other",
      source: "system",
      severity: "error",
      presentation: "banner",
      cause_code: "unknown",
    },
  });
  assert.ok(report);
  const signal = new AbortController().signal;
  assert.equal(
    await Effect.runPromise(openPanelTransport({ clientId: "unused", fetch: forbiddenFetch })(report, signal)),
    false,
  );
  assert.equal(
    await Effect.runPromise(
      openPanelTransport({
        clientId: "unused",
        endpoint: "https://analytics.openbot.run/api/track",
        fetch: forbiddenFetch,
      })(report, signal),
    ),
    false,
  );
  assert.equal(unexpectedRequests, 0);
  assert.equal(telemetryEndpoint("https://token@collector.example/api/track"), null);
  assert.equal(
    await Effect.runPromise(
      openPanelTransport({ clientId: "own-collector", endpoint: `${origin}/api/track` })(report, signal),
    ),
    true,
  );
  assert.equal(reports, 1);
  assert.equal(collectorIdentityValid, true);
  await assert.rejects(
    Effect.runPromise(
      openPanelTransport({ clientId: "own-collector", endpoint: `${origin}/redirect-collector` })(report, signal),
    ),
  );
  assert.equal(redirectedReports, 0);
  checks.push("telemetry sends nothing by default or to the vendor; an explicit owned collector receives one report");

  const bundled = await Effect.runPromise(fetchBlockedVersions(forbiddenFetch, ""));
  assert.ok(bundled.has("codex"));
  assert.equal(unexpectedRequests, 0);
  const custom = await Effect.runPromise(fetchBlockedVersions(fetch, `${origin}/runtime-blocklist.json`));
  assert.equal(custom.get("codex")?.has("9.9.9"), true);
  assert.equal(blocklistRequests, 1);
  const retained = await Effect.runPromise(fetchBlockedVersions(fetch, `${origin}/broken-blocklist.json`));
  assert.deepEqual([...retained.keys()], [...bundled.keys()]);
  assert.deepEqual([...(retained.get("codex") ?? [])], [...(bundled.get("codex") ?? [])]);
  checks.push("runtime compatibility uses bundled data offline and retains it when an owned override is invalid");

  const releaseOptions = {
    currentVersion: "0.59.0",
    packaged: true,
    platform: "darwin" as const,
    arch: "arm64",
    environment: {},
    updateStatus: () => ({ phase: "unsupported" as const }),
    installationMode: null,
    fetch: forbiddenFetch,
  };
  const releases = new HostReleaseService(releaseOptions);
  assert.equal((await Effect.runPromise(releases.check())).phase, "unavailable");
  assert.equal(supportsInstalledUpdates("darwin"), false);
  assert.equal(supportsInstalledUpdates("linux", { APPIMAGE: "/tmp/local.AppImage" }), false);
  await assert.rejects(fetchLatestLinuxRelease("arm64", forbiddenFetch, signal));
  assert.equal(unexpectedRequests, 0);
  const owned = new HostReleaseService({
    ...releaseOptions,
    environment: { OPENBOT_SELF_HOSTED_UPDATE_URL: `${origin}/releases` },
    fetch,
  });
  const available = await Effect.runPromise(owned.check());
  assert.equal(available.latestVersion, "9.9.9");
  assert.equal(available.method, "manual");
  assert.equal(feedRequests, 1);
  checks.push("packaged and host updates cannot reach the vendor; explicit owned feed discovery remains manual");

  assert.equal(githubAppConfig({}), null);
  assert.equal(
    githubAppConfig({ OPENBOT_GITHUB_CLIENT_ID: "Iv23lik5pzHz70cb0RUL", OPENBOT_GITHUB_APP_SLUG: "openbotgit" }),
    null,
  );
  const app = githubAppConfig({ OPENBOT_GITHUB_CLIENT_ID: "own.client", OPENBOT_GITHUB_APP_SLUG: "my-app" });
  assert.ok(app);
  assert.notEqual(githubAppStorageFile(app), githubAppStorageFile({ ...app, clientId: "another.client" }));
  assert.notEqual(githubAppStorageFile(app), githubAppStorageFile(null));
  const disabledBroker = new GitHubBotTokens({ apiUrl: origin, fetch: forbiddenFetch, now: Date.now });
  assert.equal(disabledBroker.due(), false);
  await Effect.runPromise(disabledBroker.renew("fixture-user-token"));
  const vendorBroker = new GitHubBotTokens({
    apiUrl: "https://api.openbot.run",
    enabled: true,
    fetch: forbiddenFetch,
    now: Date.now,
  });
  await Effect.runPromise(vendorBroker.renew("fixture-user-token"));
  assert.equal(unexpectedRequests, 0);
  const ownBroker = new GitHubBotTokens({ apiUrl: origin, enabled: true, fetch, now: Date.now });
  await Effect.runPromise(ownBroker.renew("fixture-user-token"));
  assert.equal(brokerRequests, 1);
  assert.equal(brokerIdentityValid, true);
  assert.equal(ownBroker.forRepository("fixture", "repository"), "fixture-installation-token");
  checks.push(
    "GitHub has no vendor application fallback, isolates client storage, and uses a broker only when explicitly owned",
  );
  passed = true;
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify({ passed, checks, unexpectedRequests }, null, 2)}\n`,
  );
}
logger.info("Independent network defaults passed.");
