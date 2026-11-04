// Runs the real publication service, account client and TeamStore against loopback HTTP fixtures.
// Signal is an injected transport fixture; this does not claim an Internet or native-phone test.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeRecord, requiredString } from "@openbot/contracts/ipc-decoding";
import { parseMobileConnectUrl } from "@openbot/contracts/mobile-connect";
import { createOpenBotLogger } from "@openbot/logging";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { createLocalMobileConsentStore, LOCAL_MOBILE_CONSENT_FILE } from "../src/main/local-mobile-consent-store";
import { createLocalMobilePublication, LocalMobilePublication } from "../src/main/local-mobile-publication";
import { independentAccountService, initializeLocalWorkspace, LOCAL_TEAM_FILE } from "../src/main/local-workspace";
import {
  createHostedMobileConnect,
  createHostedMobileConnectLink,
  mobileConnectAvailability,
} from "../src/main/mobile-connect-host";
import { RemoteWorkflowError, remoteCall, toRemoteWorkflowError } from "../src/main/remote-service-effects";
import { TeamStore } from "../src/main/team-store";

const logger = createOpenBotLogger("local-mobile-publication-e2e");
const directory = await mkdtemp(join(tmpdir(), "local-mobile-publication-"));
const output = resolve(".openbot-build/local-mobile-publication-e2e");
const report: { passed: boolean; checks: string[] } = { passed: false, checks: [] };
const store = new TeamStore(join(directory, LOCAL_TEAM_FILE));
await Effect.runPromise(store.initialize());
const owner = await Effect.runPromise(
  initializeLocalWorkspace(store, { serverName: "Phone test workspace", ownerName: "Local owner" }),
);
const identity = store.getIdentity();
assert.ok(identity);
const originalFile = await readFile(join(directory, LOCAL_TEAM_FILE), "utf8");
const accountToken = randomBytes(32).toString("base64url");
const machineToken = randomBytes(32).toString("base64url");
const requests: string[] = [];
const pendingResponses = new Set<ServerResponse>();
let registrationWait: ReturnType<typeof makeWait> | null = null;
let signalWait: ReturnType<typeof makeWait> | null = null;
let failSignal = false;
let localOnline = false;
let signalOnline = false;
let account: CentralAuthManager | undefined;
let publication: LocalMobilePublication | undefined;

function makeWait() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
}

async function observed(event: Promise<void>): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("The expected fixture request did not arrive.")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function send(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

const server = createServer((request, response) => {
  pendingResponses.add(response);
  response.on("close", () => pendingResponses.delete(response));
  void (async () => {
    const path = request.url ?? "/";
    requests.push(path);
    if (path === "/health/live") return send(response, { ok: true });
    if (path === "/workspace") return send(response, { online: localOnline, hostId: identity.serverId });
    let text = "";
    for await (const chunk of request) text += chunk.toString();
    const body = text ? decodeRecord(JSON.parse(text), "fixture request") : {};
    if (path === "/v1/auth/email/start")
      return send(response, { challengeId: "local-fixture", expiresAt: Date.now() + 60_000 });
    if (path === "/v1/auth/email/verify") {
      assert.equal(body.code, "123456");
      return send(response, {
        sessionToken: accountToken,
        user: { id: "account-owner", email: "owner@example.test", name: "Owner", avatarUrl: null },
      });
    }
    if (path === "/signal") {
      assert.equal(body.machineToken, machineToken);
      const wait = signalWait;
      wait?.entered.resolve();
      if (wait) await wait.release.promise;
      return send(response, { ready: !failSignal }, failSignal ? 503 : 200);
    }
    assert.equal(request.headers.authorization, `Bearer ${accountToken}`);
    if (path === "/v1/auth/logout") return send(response, {});
    if (path === "/v2/remote/hosts/register") {
      assert.equal(body.hostId, identity.serverId);
      assert.equal(body.ownerMembershipId, owner.id);
      assert.equal(body.devicePublicKey, identity.publicKey);
      const wait = registrationWait;
      wait?.entered.resolve();
      if (wait) await wait.release.promise;
      return send(response, {
        hostId: identity.serverId,
        name: identity.serverName,
        membershipId: owner.id,
        authEpoch: 1,
        machineToken,
      });
    }
    if (path === "/v1/mobile-auth/ticket" || path === "/v1/mobile-auth/link") {
      assert.equal(signalOnline, true, "Do not issue a pairing code before Signal is ready.");
      const binding = decodeRecord(body.host, "pairing host");
      assert.equal(binding.hostId, identity.serverId);
      assert.equal(binding.fingerprint, identity.fingerprint);
      return send(
        response,
        path.endsWith("ticket")
          ? { ticket: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000 }
          : { link: randomBytes(32).toString("base64url"), createdAt: Date.now() },
      );
    }
    throw new Error(`Unexpected fixture path: ${path}`);
  })().catch((error) => {
    logger.error("Local fixture rejected a request.", error);
    send(response, { code: "fixture_failure", message: "The local test fixture rejected this request." }, 500);
  });
});

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const centralAuth = new CentralAuthManager({
    ...independentAccountService(directory, origin),
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
  account = centralAuth;
  const consentPath = join(directory, LOCAL_MOBILE_CONSENT_FILE);
  let consentStore = createLocalMobileConsentStore(consentPath);
  await Effect.runPromise(consentStore.load());
  const publicationOptions = {
    accountOrigin: origin,
    consent: consentStore,
    getAccountId: () => {
      const state = centralAuth.getState();
      return state.status === "signed_in" ? state.user.id : null;
    },
    getHost: () => ({ hostId: identity.serverId, fingerprint: identity.fingerprint }),
    startLoopback: () =>
      Effect.sync(() => {
        localOnline = true;
      }),
    register: () =>
      centralAuth
        .registerRemoteHost({
          hostId: identity.serverId,
          name: identity.serverName,
          ownerMembershipId: owner.id,
          devicePublicKey: identity.publicKey,
        })
        .pipe(toRemoteWorkflowError),
    publish: () =>
      remoteCall(async () => {
        const response = await fetch(`${origin}/signal`, { method: "POST", body: JSON.stringify({ machineToken }) });
        if (!response.ok) throw new Error("The Signal fixture failed.");
        signalOnline = true;
      }),
    stop: () =>
      Effect.sync(() => {
        signalOnline = false;
      }),
    closeRemoteSessions: () => {
      for (const session of store.listSessions()) store.closeRemoteSession(session.id);
    },
    changed: () => {},
  };
  let service = new LocalMobilePublication(publicationOptions);
  publication = service;
  const pendingTeardowns: Promise<void>[] = [];
  centralAuth.on("changed", (state) => {
    pendingTeardowns.push(
      Effect.runPromise(
        service.accountChanged(state.status === "signed_in" ? state.user.id : null, state.status === "signed_out"),
      ),
    );
  });
  const getHostStatus = () => ({
    configured: true,
    serverId: identity.serverId,
    phase: "online",
    apiOnline: localOnline,
    apiUrl: origin,
    message: null,
  });
  const host = {
    configure: () => Effect.fail(new RemoteWorkflowError({ cause: new Error("Never reconfigure this workspace.") })),
    getStatus: getHostStatus,
    getMobileConnectHost: () => ({ hostId: identity.serverId, fingerprint: identity.fingerprint }),
    isMobileConnectPublished: () => service.isPublished(),
    publishForMobileConnect: () => service.publish().pipe(Effect.map(getHostStatus)),
  };
  const connect = () => Effect.runPromise(createHostedMobileConnect({ centralAuth, host }).pipe(Effect.result));
  const signIn = async () => {
    const challenge = await Effect.runPromise(centralAuth.requestEmailCode("owner@example.test"));
    assert.equal(challenge.status, "code_sent");
    if (challenge.status !== "code_sent") throw new Error("No local challenge was returned.");
    assert.equal(
      (await Effect.runPromise(centralAuth.verifyEmailCode(challenge.challengeId, "123456"))).status,
      "signed_in",
    );
  };
  const signOut = async () => {
    await Effect.runPromise(centralAuth.logout());
    await Promise.all(pendingTeardowns);
  };
  await Effect.runPromise(centralAuth.initialize());
  assert.equal(mobileConnectAvailability(centralAuth, host).state, "signed-out");
  assert.ok(Result.isFailure(await connect()));
  assert.equal(requests.includes("/v2/remote/hosts/register"), false);
  await signIn();
  await Effect.runPromise(service.restore());
  assert.equal(mobileConnectAvailability(centralAuth, host).state, "unpublished");
  assert.equal(requests.includes("/v2/remote/hosts/register"), false);
  report.checks.push("Real account sign-in and read-only availability never publish the local host.");

  signalWait = makeWait();
  const pairing = connect();
  await observed(signalWait.entered.promise);
  assert.equal(requests.includes("/v1/mobile-auth/ticket"), false);
  signalWait.release.resolve();
  const connected = await pairing;
  assert.ok(Result.isSuccess(connected));
  const qr = parseMobileConnectUrl(connected.success.qrData);
  assert.ok(qr);
  assert.deepEqual(qr.host, host.getMobileConnectHost());
  assert.equal(mobileConnectAvailability(centralAuth, host).state, "ready");
  await Effect.runPromise(createHostedMobileConnectLink({ centralAuth, host }));
  assert.equal(requests.filter((path) => path === "/v2/remote/hosts/register").length, 1);
  report.checks.push("Registration preserves the host key and owner ID; QR and links wait for Signal readiness.");
  signalWait = null;

  const savedConsent = consentStore.get().consent;
  assert.ok(savedConsent);
  assert.deepEqual(savedConsent, { accountId: "account-owner", accountOrigin: origin, ...host.getMobileConnectHost() });
  service.reset();
  signalOnline = false;
  consentStore = createLocalMobileConsentStore(consentPath);
  await Effect.runPromise(consentStore.load());
  service = new LocalMobilePublication({ ...publicationOptions, consent: consentStore });
  publication = service;
  const requestsBeforeRestart = requests.length;
  assert.equal(service.isPublished(), false);
  assert.equal(requests.length, requestsBeforeRestart);
  await Effect.runPromise(service.restore());
  assert.equal(service.isPublished(), true);
  assert.equal(signalOnline, true);
  assert.equal(requests.filter((path) => path === "/v1/mobile-auth/ticket").length, 1);
  report.checks.push(
    "A fresh publication service restores an exact saved account/origin/host/fingerprint without a new pairing code.",
  );

  const mismatches = [
    { name: "account", getAccountId: () => "another-account" },
    { name: "origin", accountOrigin: "https://another.example" },
    { name: "host", getHost: () => ({ hostId: "another-host", fingerprint: identity.fingerprint }) },
    {
      name: "fingerprint",
      getHost: () => ({ hostId: identity.serverId, fingerprint: randomBytes(32).toString("base64url") }),
    },
  ];
  for (const mismatch of mismatches) {
    const otherStore = createLocalMobileConsentStore(join(directory, `consent-${mismatch.name}.json`));
    await Effect.runPromise(otherStore.set({ consent: savedConsent }));
    const refused = new LocalMobilePublication({ ...publicationOptions, ...mismatch, consent: otherStore });
    const before = requests.length;
    await Effect.runPromise(refused.restore());
    assert.equal(refused.isPublished(), false);
    assert.equal(requests.length, before);
    assert.equal(otherStore.get().consent, null);
  }
  const malformedPath = join(directory, "malformed-consent.json");
  await writeFile(malformedPath, '{"version":1,"consent":{"accountId":"account-owner"}}');
  const malformedStore = createLocalMobileConsentStore(malformedPath);
  await Effect.runPromise(malformedStore.load());
  const malformed = new LocalMobilePublication({ ...publicationOptions, consent: malformedStore });
  const beforeMalformed = requests.length;
  await Effect.runPromise(malformed.restore());
  assert.equal(requests.length, beforeMalformed);
  assert.equal(malformed.isPublished(), false);
  report.checks.push(
    "Missing, malformed, and mismatched consent never publishes; all four binding fields are checked.",
  );

  const disabledConsent = createLocalMobileConsentStore(join(directory, "disabled-consent.json"));
  await Effect.runPromise(disabledConsent.set({ consent: savedConsent }));
  const disabledAccount = new CentralAuthManager({
    ...independentAccountService(directory),
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
  try {
    const disabledPublication = new LocalMobilePublication({
      ...publicationOptions,
      consent: disabledConsent,
      getAccountId: () => null,
    });
    const beforeDisabled = requests.length;
    const disabledState = await Effect.runPromise(disabledAccount.initialize());
    assert.equal(disabledState.status, "signed_out");
    await Effect.runPromise(
      disabledPublication.accountChanged(null, disabledState.status === "signed_out" && disabledAccount.isEnabled()),
    );
    await Effect.runPromise(disabledPublication.restore());
    assert.equal(disabledPublication.isPublished(), false);
    assert.deepEqual(disabledConsent.get().consent, savedConsent);
    assert.equal(requests.length, beforeDisabled);
  } finally {
    await Effect.runPromise(disabledAccount.dispose());
  }
  report.checks.push("An unconfigured account service preserves saved consent without publishing or sending requests.");

  const beforeChild = requests.length;
  const childPublication = createLocalMobilePublication({
    ...publicationOptions,
    consent: undefined,
    getAccountId: () => null,
  });
  assert.equal(childPublication, null);
  assert.equal(requests.length, beforeChild);
  report.checks.push(
    "A local child server with no desktop consent store gets no account-gating controller; its parent grant path stays separate.",
  );

  store.openRemoteSession({
    sessionId: "phone-session",
    membershipId: owner.id,
    userId: "account-owner",
    role: "owner",
  });
  service.rememberSession({ hostId: identity.serverId, sessionId: "phone-session" });
  assert.equal(service.hasSession("phone-session"), true);
  await signOut();
  assert.equal(signalOnline, false);
  assert.equal(
    store.listSessions().some((session) => session.id === "phone-session"),
    false,
  );
  assert.equal(localOnline, true);
  const revokedConsent = createLocalMobileConsentStore(consentPath);
  await Effect.runPromise(revokedConsent.load());
  assert.equal(revokedConsent.get().consent, null);
  report.checks.push("Sign-out stops external access and revokes remote sessions while loopback remains online.");

  await signIn();
  const beforeRevokedRestore = requests.length;
  await Effect.runPromise(service.restore());
  assert.equal(requests.length, beforeRevokedRestore);
  assert.equal(service.isPublished(), false);
  failSignal = true;
  assert.ok(Result.isFailure(await connect()));
  assert.equal(mobileConnectAvailability(centralAuth, host).state, "unpublished");
  assert.equal(localOnline, true);
  failSignal = false;
  assert.ok(Result.isSuccess(await connect()));
  service.signalFailed();
  assert.equal(service.isPublished(), false);
  assert.equal(localOnline, true);
  assert.ok(Result.isSuccess(await connect()));
  report.checks.push("Signal start and recovery failures leave the local workspace available; explicit retry works.");

  const verifyWait = makeWait();
  const verifying = Effect.runPromise(
    service
      .withAccount(
        remoteCall(async () => {
          verifyWait.entered.resolve();
          await verifyWait.release.promise;
          return "verified-session";
        }),
      )
      .pipe(Effect.result),
  );
  await observed(verifyWait.entered.promise);
  await signOut();
  await signIn();
  verifyWait.release.resolve();
  assert.ok(Result.isFailure(await verifying));
  report.checks.push("A verification from a revoked grant stays rejected after the same account signs in again.");

  registrationWait = makeWait();
  const stalePairing = connect();
  await observed(registrationWait.entered.promise);
  const signalCount = requests.filter((path) => path === "/signal").length;
  await signOut();
  await signIn();
  registrationWait.release.resolve();
  assert.ok(Result.isFailure(await stalePairing));
  assert.equal(requests.filter((path) => path === "/signal").length, signalCount);
  assert.equal(service.isPublished(), false);
  report.checks.push("A registration completed after sign-out cannot publish or create a pairing code.");
  const lateConsent = createLocalMobileConsentStore(consentPath);
  await Effect.runPromise(lateConsent.load());
  assert.equal(lateConsent.get().consent, null);

  registrationWait = null;
  assert.ok(Result.isSuccess(await connect()));
  await Effect.runPromise(service.revoke());
  assert.equal(signalOnline, false);
  assert.equal(localOnline, true);
  const stoppedConsent = createLocalMobileConsentStore(consentPath);
  await Effect.runPromise(stoppedConsent.load());
  assert.equal(stoppedConsent.get().consent, null);
  const beforeStoppedRestore = requests.length;
  await Effect.runPromise(service.restore());
  assert.equal(requests.length, beforeStoppedRestore);
  report.checks.push(
    "Sign-out and explicit stop remove durable consent; later sign-in and late registration cannot revive it.",
  );

  registrationWait = makeWait();
  const beforeShutdownSignals = requests.filter((path) => path === "/signal").length;
  const publishingAtShutdown = connect();
  await observed(registrationWait.entered.promise);
  // runFork starts synchronously until the busy publication semaphore suspends this request.
  const queuedAtShutdown = Effect.runFork(service.publish().pipe(Effect.result));
  assert.equal(queuedAtShutdown.pollUnsafe(), undefined);
  service.reset();
  await Effect.runPromise(publicationOptions.stop());
  registrationWait.release.resolve();
  assert.ok(Result.isFailure(await publishingAtShutdown));
  assert.ok(Result.isFailure(await Effect.runPromise(Fiber.join(queuedAtShutdown))));
  assert.equal(requests.filter((path) => path === "/signal").length, beforeShutdownSignals);
  assert.equal(signalOnline, false);
  assert.equal(service.isPublished(), false);
  report.checks.push(
    "Shutdown invalidates both an in-flight registration and a queued publish before either can start Signal.",
  );

  const blockedConsentPath = join(directory, "blocked-consent.json");
  await mkdir(blockedConsentPath);
  const stopFailure = new Error("Fixture gateway stop failed.");
  const failedCleanup = new LocalMobilePublication({
    ...publicationOptions,
    consent: createLocalMobileConsentStore(blockedConsentPath),
    stop: () => Effect.fail(new RemoteWorkflowError({ cause: stopFailure })),
  });
  const teardown = await Effect.runPromise(Effect.exit(failedCleanup.revoke()));
  assert.ok(Exit.isFailure(teardown));
  const failures = teardown.cause.reasons.filter(Cause.isFailReason);
  assert.equal(failures.length, 2);
  assert.ok(failures.some((reason) => reason.error.cause === stopFailure));
  assert.ok(failures.some((reason) => reason.error.cause instanceof Error && "code" in reason.error.cause));
  report.checks.push("Gateway-stop and consent-file failures are both retained; cleanup still runs after stop fails.");

  const workspace = decodeRecord(await (await fetch(`${origin}/workspace`)).json(), "local workspace");
  assert.equal(workspace.online, true);
  assert.equal(requiredString(workspace, "hostId"), identity.serverId);
  assert.equal(await readFile(join(directory, LOCAL_TEAM_FILE), "utf8"), originalFile);
  assert.equal(store.getOwnerMemberId(), owner.id);
  assert.equal(store.getOwnerEmail(), null);
  report.checks.push("All success, failure and revocation paths preserve the complete local identity file.");
  report.passed = true;
  logger.info("Local mobile publication checks passed.");
} finally {
  signalWait?.release.resolve();
  registrationWait?.release.resolve();
  publication?.reset();
  for (const response of pendingResponses) response.destroy();
  if (account) await Effect.runPromise(account.dispose());
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(directory, { recursive: true, force: true });
}
