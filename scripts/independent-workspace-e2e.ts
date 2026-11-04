// Real local identity files and an account-service fixture. No user data or upstream service is used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { independentAccountService, initializeLocalWorkspace, LOCAL_TEAM_FILE } from "../src/main/local-workspace";
import { TeamStore } from "../src/main/team-store";

const logger = createOpenBotLogger("independent-workspace-e2e");
const directory = await mkdtemp(join(tmpdir(), "independent-workspace-"));
const output = resolve(".openbot-build/independent-workspace-e2e");
const report: { passed: boolean; checks: string[] } = { passed: false, checks: [] };
let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
});
const managers: CentralAuthManager[] = [];
try {
  const oldAuthPath = join(directory, "openbot-central-auth-v1.bin");
  const oldTeamPath = join(directory, "openbot-team-server-v2.json");
  await writeFile(oldAuthPath, "original encrypted account bytes");
  await writeFile(oldTeamPath, "original account-owned host bytes");
  const config = independentAccountService(directory);
  let decrypted = 0;
  let forbiddenRequests = 0;
  const local = new CentralAuthManager({
    ...config,
    // Even an explicitly supplied old path must not be read in disabled mode.
    storagePath: oldAuthPath,
    encrypt: (value) => Buffer.from(value),
    decrypt: () => {
      decrypted += 1;
      throw new Error("The old account must not be decrypted.");
    },
    fetch: async () => {
      forbiddenRequests += 1;
      throw new Error("No account transport is permitted.");
    },
  });
  managers.push(local);
  assert.equal((await Effect.runPromise(local.initialize())).status, "signed_out");
  assert.equal(decrypted, 0);
  const denied = await Effect.runPromise(
    Effect.result(local.requestAuthorized("/v1/me/license", { method: "GET" }, () => true)),
  );
  assert.ok(Result.isFailure(denied));
  const login = await Effect.runPromise(Effect.result(local.requestEmailCode("owner@example.test")));
  assert.ok(Result.isFailure(login));
  assert.equal(local.getState().status, "signed_out");
  assert.equal(forbiddenRequests, 0);
  assert.equal(await readFile(oldAuthPath, "utf8"), "original encrypted account bytes");
  report.checks.push(
    "disabled account service neither reads old credentials nor sends health, license, or sign-in requests",
  );

  const store = new TeamStore(join(directory, LOCAL_TEAM_FILE));
  await Effect.runPromise(store.initialize());
  const owner = await Effect.runPromise(
    initializeLocalWorkspace(store, { serverName: "My local workspace", ownerName: "Local owner" }),
  );
  assert.equal(store.getOwnerMemberId(), owner.id);
  assert.equal(store.listMembers().length, 1);
  assert.equal(store.listMembers()[0]?.role, "owner");
  assert.equal(store.getOwnerEmail(), null);
  const restarted = new TeamStore(join(directory, LOCAL_TEAM_FILE));
  await Effect.runPromise(restarted.initialize());
  const same = await Effect.runPromise(
    initializeLocalWorkspace(restarted, { serverName: "My local workspace", ownerName: "Local owner" }),
  );
  assert.deepEqual(same, owner);
  assert.equal(restarted.getIdentity()?.serverId, store.getIdentity()?.serverId);
  assert.equal(await readFile(oldTeamPath, "utf8"), "original account-owned host bytes");
  report.checks.push("local owner and host survive restart; the original account-owned files remain unchanged");

  const a = independentAccountService(directory, "https://account-a.example");
  const b = independentAccountService(directory, "https://account-b.example");
  assert.notEqual(a.storagePath, b.storagePath);
  assert.notEqual(a.storagePath, oldAuthPath);
  assert.throws(() => independentAccountService(directory, "https://api.openbot.run"));
  assert.throws(() => independentAccountService(directory, "https://api.openbot.run."));
  assert.throws(() => independentAccountService(directory, "invalid-secret-value"), /valid origin/);
  assert.throws(() => independentAccountService(directory, "https://name:password@own.example"));
  assert.throws(() => independentAccountService(directory, "http://public.example"));
  report.checks.push("self-hosted sessions are scoped to a validated origin and never reuse an upstream account file");

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const own = new CentralAuthManager({
    ...independentAccountService(directory, `http://127.0.0.1:${address.port}`),
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
  managers.push(own);
  assert.equal((await Effect.runPromise(own.initialize())).status, "signed_out");
  assert.equal(requests, 1);
  report.checks.push("an explicitly configured self-hosted service is the only account origin contacted");
  report.passed = true;
  logger.info("Independent local workspace checks passed.");
} finally {
  for (const manager of managers) await Effect.runPromise(manager.dispose());
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(directory, { recursive: true, force: true });
}
