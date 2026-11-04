// Drives the real discovery, encrypted endpoint store, sync service and loopback HTTP endpoint.
// Provider lifecycle callbacks are injected; no installed runtime or user account is changed.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CUSTOM_PROVIDER_LIMITS,
  type CustomProviderModelSyncState,
  type CustomProviderRestart,
  DEFAULT_PROVIDER_DETECTION_SETTINGS,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import {
  type CustomProviderChangeDependencies,
  createCustomProviderChanges,
} from "../src/main/custom-provider-changes";
import { type CustomProviderModelSync, createCustomProviderModelSync } from "../src/main/custom-provider-model-sync";
import { CustomProviderStore } from "../src/main/custom-provider-store";
import { parseSaveCustomProvider } from "../src/main/ipc/custom-provider-inputs";
import { createProviderDetection } from "../src/main/provider-detection";
import { decodeCustomProviderModelSyncStates } from "../src/preload/custom-provider-model-sync-decoding";

const logger = createOpenBotLogger("custom-provider-model-sync-e2e");
const directory = await mkdtemp(join(tmpdir(), "openbot-model-sync-"));
const output = resolve(".openbot-build/custom-provider-model-sync-e2e");
const key = randomBytes(32);
const fixtureToken = `fixture-${randomUUID()}`;
const cipher = {
  canPersist: () => true,
  encrypt: (text: string) => {
    const iv = randomBytes(12);
    const aes = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([aes.update(text, "utf8"), aes.final()]);
    return Buffer.concat([iv, aes.getAuthTag(), encrypted]);
  },
  decrypt: (data: Buffer) => {
    const aes = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    aes.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([aes.update(data.subarray(28)), aes.final()]).toString("utf8");
  },
};
let models = Array.from({ length: 70 }, (_, index) => `model-${index}`);
let fail = false;
let hold = false;
let requests = 0;
let credentialsMatch = true;
const entered = Promise.withResolvers<void>();
const aborted = Promise.withResolvers<void>();
const server = createServer((request, response) => {
  requests += 1;
  credentialsMatch &&=
    request.headers.authorization === `Bearer ${fixtureToken}` && request.headers["x-fixture"] === "saved-header";
  assert.equal(request.url, "/v1/models");
  if (hold) {
    response.on("close", () => {
      if (!response.writableEnded) aborted.resolve();
    });
    entered.resolve();
    return;
  }
  if (fail) {
    response.writeHead(401).end("Private upstream detail must not reach status");
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ data: models.map((id) => ({ id })) }));
});
const checks: string[] = [];
let passed = false;
const cleanup: Array<() => Promise<void>> = [];

function waitForState(
  sync: CustomProviderModelSync,
  predicate: (state: CustomProviderModelSyncState) => boolean,
): Promise<void> {
  return new Promise((done, reject) => {
    const deadline = AbortSignal.timeout(10_000);
    const finish = () => {
      unsubscribe();
      deadline.removeEventListener("abort", timeout);
      done();
    };
    const timeout = () => {
      unsubscribe();
      reject(new Error("Model sync did not reach the expected state."));
    };
    const unsubscribe = sync.subscribe((states) => {
      if (states.some(predicate)) finish();
    });
    deadline.addEventListener("abort", timeout, { once: true });
    if (sync.list().some(predicate)) finish();
  });
}

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const path = join(directory, "endpoints.json");
  const store = new CustomProviderStore({ path, cipher });
  await Effect.runPromise(store.load());
  const input = {
    id: "fixture-model-sync",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: fixtureToken,
    headers: [{ name: "X-Fixture", value: "saved-header" }],
    models: models.map((id) => ({ id, name: id })),
  };
  await Effect.runPromise(store.save(parseSaveCustomProvider(input)));
  assert.equal(store.list()[0]?.models.length, 70);
  assert.throws(() => parseSaveCustomProvider(input, CUSTOM_PROVIDER_LIMITS.models));
  const before = await readFile(path, "utf8");
  assert.equal(before.includes(fixtureToken), false);
  assert.equal(before.includes("saved-header"), false);
  checks.push(
    "A native endpoint accepts all 70 models while the released save bound remains 64; credentials are encrypted on disk",
  );

  const discovery = await Effect.runPromise(
    createProviderDetection({
      settings: { get: () => DEFAULT_PROVIDER_DETECTION_SETTINGS },
      customProviders: store,
      customAgents: { configs: () => [] },
    }),
  );
  cleanup.push(() => Effect.runPromise(discovery.close()));
  let restarts = 0;
  const service: CustomProviderChangeDependencies["service"] = {
    saveCustomProvider: (_id, _harness, persist) => persist(),
    updateCustomProvider: (_id, _harness, removed, persist) => {
      assert.deepEqual(removed, [], "Automatic synchronization must not request model removal or fallback.");
      return persist();
    },
    removeCustomProvider: (_id, persist) => persist(),
    reloadCustomProviderConfig: () =>
      Effect.sync<CustomProviderRestart>(() => {
        restarts += 1;
        return "skipped-busy";
      }),
    startHarnessForMovedAgents: () => Effect.void,
  };
  const changes = createCustomProviderChanges({
    service,
    customProviders: store,
    providerRuntimes: { startCustomProviderHarness: () => Effect.void },
    discovery,
  });
  const sync = await Effect.runPromise(createCustomProviderModelSync({ store, changes }));
  cleanup.unshift(() => Effect.runPromise(sync.close()));
  assert.equal(sync.list()[0]?.enabled, false);
  await Effect.runPromise(sync.setEnabled({ id: input.id, enabled: false }));
  assert.equal(requests, 0);
  await Effect.runPromise(sync.setEnabled({ id: input.id, enabled: true }));
  assert.equal(requests, 1);
  assert.equal(sync.list()[0]?.upstreamCount, 70);
  assert.equal(restarts, 0);
  assert.equal(JSON.stringify(sync.list()).includes(fixtureToken), false);
  assert.throws(() => decodeCustomProviderModelSyncStates([{ ...sync.list()[0], apiKey: fixtureToken }]));
  assert.throws(() =>
    decodeCustomProviderModelSyncStates([
      { ...sync.list()[0], headers: [{ name: "Authorization", value: fixtureToken }] },
    ]),
  );
  checks.push(
    "Old/default settings are disabled; explicit enable performs one authenticated discovery and an unchanged catalog does not restart a provider",
  );

  models = [...models.slice(1), "model-new"];
  await Effect.runPromise(sync.refresh(input.id));
  assert.equal(store.list()[0]?.models.length, 71);
  assert.ok(store.list()[0]?.models.some((model) => model.id === "model-0"));
  assert.deepEqual(sync.list()[0]?.missingModelIds, ["model-0"]);
  assert.equal(sync.list()[0]?.lastRestart, "skipped-busy");
  assert.equal(restarts, 1);
  const success = sync.list()[0]?.lastSuccessAt;
  fail = true;
  await Effect.runPromise(sync.refresh(input.id));
  assert.equal(sync.list()[0]?.lastFailure, "failed");
  assert.equal(sync.list()[0]?.lastSuccessAt, success);
  assert.equal(store.list()[0]?.models.length, 71);
  assert.equal(JSON.stringify(sync.list()).includes("Private upstream"), false);
  fail = false;
  await Effect.runPromise(sync.refresh(input.id));
  assert.equal(sync.list()[0]?.lastFailure, null);
  assert.ok(credentialsMatch);
  checks.push(
    "Refresh adds new models, marks upstream removals without deleting selected models, preserves the catalog on authentication failure, and recovers on the next refresh",
  );

  await Effect.runPromise(sync.close());
  const loaded = new CustomProviderStore({ path, cipher });
  await Effect.runPromise(loaded.load());
  assert.equal(loaded.modelSyncStates()[0]?.enabled, true);
  assert.deepEqual(loaded.modelSyncStates()[0]?.missingModelIds, ["model-0"]);
  assert.equal(loaded.configs()[0]?.apiKey, fixtureToken);
  await Effect.runPromise(store.setModelSync(input.id, { lastAttemptAt: new Date(0).toISOString() }));
  models = [...models, "model-after-restart"];
  const resumed = await Effect.runPromise(createCustomProviderModelSync({ store, changes, intervalMs: 50 }));
  cleanup.unshift(() => Effect.runPromise(resumed.close()));
  await waitForState(resumed, (state) => !state.running && state.upstreamCount === 71);
  models = [...models, "model-next-cycle"];
  await waitForState(resumed, (state) => !state.running && state.upstreamCount === 72);
  await Effect.runPromise(resumed.setEnabled({ id: input.id, enabled: false }));
  const disabledRequests = requests;
  await Effect.runPromise(changes.syncModels(input.id, true));
  assert.equal(requests, disabledRequests);
  checks.push(
    "Enabled metadata survives reload, due startup and periodic cycles use the real endpoint, and disabling prevents further automatic discovery",
  );

  hold = true;
  const pending = Effect.runPromise(resumed.refresh(input.id)).then(
    () => false,
    () => true,
  );
  await entered.promise;
  await Effect.runPromise(resumed.close());
  await Effect.runPromise(discovery.close());
  assert.equal(await pending, true);
  await aborted.promise;
  assert.equal(resumed.list()[0]?.running, false);
  checks.push("Shutdown interrupts an in-flight manual refresh and aborts its owned discovery request");
  passed = true;
} finally {
  for (const close of cleanup) await close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, requests, credentialsMatch }, null, 2)}\n`,
  );
  await rm(directory, { recursive: true, force: true });
}
logger.info("Custom provider model synchronization E2E passed.");
