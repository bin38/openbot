// Runs the Worker boundary and account service against real local HTTP and an in-memory database.
// Run: bun scripts/independent-account-api-e2e.ts
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TEAM_MEMBER_LIMIT } from "@openbot/contracts/input-limits";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { REMOTE_TICKET_AUDIENCE } from "@openbot/contracts/signal-protocol/ticket";
import { Effect } from "effect";
import { jwtVerify } from "jose";
import { OPENBOT_LINKS } from "../src/lib/landing-links";
import { createAccountAnalytics } from "../src/server/account-analytics";
import { pruneExpiredAuthData } from "../src/server/auth-data-retention";
import { renderSignInCodeEmail, renderTeamInviteEmail } from "../src/server/email-templates";
import { latestDownloadResponse } from "../src/server/latest-download";
import {
  deliverPendingRemoteAuthEvents,
  RemoteControlPlane,
  remoteSignalPlan,
  verifyRemoteServiceSignature,
} from "../src/server/remote-control-plane";
import { SIGNAL_ENTRY_CRON } from "../src/server/signal-entry-failover";
import type { AuthUser } from "../src/server/types";
import { createWorkerHandler } from "../src/server/worker-handler";
import { sqliteD1 } from "./sqlite-d1";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build/independent-account-api-e2e");
const NOW = Date.UTC(2026, 10, 4);
const HOST = "independent-host";
const SECRET = "local-fixture-auth-event-secret";
const checks: string[] = [];
const database = new DatabaseSync(":memory:");
const nativeFetch = globalThis.fetch;
let routedRequests = 0;
let unexpectedRequests = 0;
let authEvents = 0;
let retentionRuns = 0;
let deliveryRuns = 0;
let signedEvents = true;
let passed = false;

async function outcome<A, E>(operation: Effect.Effect<A, E>): Promise<string> {
  return Effect.runPromise(
    operation.pipe(
      Effect.match({
        onSuccess: () => "ok",
        onFailure: (error) =>
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failure",
      }),
    ),
  );
}

function addUser(id: string): AuthUser {
  const email = `${id}@example.test`;
  database
    .prepare("INSERT INTO users(id, identity_key, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, `email:${id}`, email, NOW, NOW);
  return { id, email, name: null, avatarUrl: null, analyticsEnabled: null };
}

const worker = createWorkerHandler(
  () => {
    routedRequests += 1;
    return Response.json({ handled: true });
  },
  (db, now) => {
    retentionRuns += 1;
    return pruneExpiredAuthData(db, now);
  },
  () => undefined,
  (bindings, now) => {
    deliveryRuns += 1;
    return deliverPendingRemoteAuthEvents(bindings, now);
  },
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname === "/auth-events") {
      const body = await request.text();
      const verified = await Effect.runPromise(
        verifyRemoteServiceSignature(
          SECRET,
          body,
          request.headers.get("OpenBot-Timestamp") ?? "",
          request.headers.get("OpenBot-Signature") ?? "",
          NOW,
        ),
      );
      signedEvents &&= verified;
      authEvents += 1;
      return new Response(null, { status: verified ? 204 : 401 });
    }
    return worker.fetch(request, {
      MARKETPLACE_INGRESS_RATE_LIMITER: { limit: async () => ({ success: true }) },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const guardedFetch: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) {
      unexpectedRequests += 1;
      throw new Error("The independent service tried to contact an external endpoint.");
    }
    return nativeFetch(input, init);
  },
  { preconnect: nativeFetch.preconnect },
);

try {
  globalThis.fetch = guardedFetch;
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = join(ROOT, "apps/auth-api/migrations");
  for (const file of (await readdir(migrations)).sort()) database.exec(await readFile(join(migrations, file), "utf8"));
  const db = sqliteD1(database);
  const blocked = [
    "/v1/me/billing",
    "/v1/me/billing/portal",
    "/v1/me/license",
    "/v1/me/license/checkout",
    "/v1/me/license/users",
    "/v1/me/license/plan",
    "/v1/me/license/renewal",
    "/v1/stripe/webhook",
    "/v2/hosting/plans",
    "/v2/hosting/claims/redeem",
    "/v2/hosting/boat/webhook",
    "/v2/hosting/servers",
    "/v2/hosting/servers/host/checkout",
    "/v2/hosting/servers/host/wake",
    "/v1/sites",
    "/v1/sites/uploads/file/activate",
    "/health/hosting",
    "/billing/checkout-return",
    "/billing/return",
    "/v1/me/%6cicense/checkout",
    "/api/browser/v1/me/billing",
    "/api/browser/v1/me/license/checkout",
    "/api/browser/v2/hosting/plans",
    "/api/browser/v2/hosting/servers",
    "/api/browser/v1/sites",
  ];
  for (const path of blocked) {
    const response = await fetch(`${origin}${path}`, { method: "POST" });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.ok(isDynamicRecord(body));
    assert.ok(isDynamicRecord(body.error));
    assert.equal(body.error.code, "service_unavailable");
  }
  assert.equal(routedRequests, 0);
  for (const path of ["/v1/me", "/v1/me/profile", "/v1/remote/hosts", "/health/ready", "/v1/me/license-other"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 200);
  }
  assert.equal(routedRequests, 5);
  checks.push("Commercial API requests stop before the router; account and remote routes remain reachable.");

  for (const platform of ["macos", "windows", "linux"] as const) {
    const response = await Effect.runPromise(latestDownloadResponse(platform, guardedFetch));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
    const body = await response.json();
    assert.ok(isDynamicRecord(body));
    assert.equal(body.source, OPENBOT_LINKS.repository);
  }
  assert.equal(OPENBOT_LINKS.repository, "https://github.com/bin38/openbot");
  assert.equal(OPENBOT_LINKS.releases, OPENBOT_LINKS.repository);
  checks.push(
    "Installers stay unavailable without an owned release source and do not fetch original release manifests.",
  );

  const analytics = createAccountAnalytics({
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    fetch: (input, init) => guardedFetch(input, init),
    schedule: () => {
      throw new Error("Independent account analytics scheduled a send.");
    },
    database: db,
  });
  analytics.track("owner", { name: "account_created", surface: "desktop", firstTouch: null });
  checks.push("Account analytics stays disabled even when old client credentials exist.");

  const emails = [
    renderSignInCodeEmail({ code: "TEST-CODE", expiresInMinutes: 10 }),
    renderTeamInviteEmail({
      inviterEmail: "owner@example.test",
      serverName: "Owned server",
      inviteUrl: `${origin}/join/fixture`,
      role: "member",
    }),
  ];
  for (const email of emails) {
    assert.ok(!email.html.includes("openbot.run"));
    assert.ok(!email.text.includes("openbot.run"));
    assert.ok(!email.html.includes("<img"));
  }
  assert.ok(emails[1]?.text.includes(`${origin}/join/fixture`));
  checks.push("Account email keeps the owned invitation URL and has no original-service links or remote image.");

  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const bindings = {
    DB: db,
    REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "fixture-key" }),
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: "fixture-key" }] }),
    REMOTE_TICKET_KEY_ID: "fixture-key",
    REMOTE_SIGNAL_URL: `ws://127.0.0.1:${server.port}`,
  };
  const owner = addUser("owner");
  const member = addUser("member");
  const other = addUser("other");
  const remote = new RemoteControlPlane(bindings, { now: () => NOW, fetch: guardedFetch });
  await Effect.runPromise(
    remote.registerHost(owner, { hostId: HOST, name: "Owned server", ownerMembershipId: "owner-member" }),
  );
  database
    .prepare(`INSERT INTO licenses(stripe_subscription_id, user_id, stripe_customer_id, users, currency, status, updated_at)
    VALUES ('old-unpaid-license', 'owner', 'old-customer', 1, 'usd', 'unpaid', ?)`)
    .run(NOW);
  const before = database.prepare("SELECT * FROM licenses").all();
  const listed = await Effect.runPromise(remote.listHosts(owner.id));
  assert.equal(listed[0]?.memberLimit, DEFAULT_TEAM_MEMBER_LIMIT);
  assert.equal(listed[0]?.hosted, false);
  database
    .prepare(`INSERT INTO server_member_limits(server_id, owner_user_id, member_limit, created_at, updated_at)
    VALUES (?, 'owner', 2, ?, ?)`)
    .run(HOST, NOW, NOW);
  const invite = await Effect.runPromise(
    remote.createInvite(owner, { hostId: HOST, role: "member", email: member.email }),
  );
  assert.equal(await outcome(remote.acceptInvite(other, invite.token)), "invite_email_mismatch");
  const membership = await Effect.runPromise(remote.acceptInvite(member, invite.token));
  assert.equal(membership.role, "member");
  assert.deepEqual(database.prepare("SELECT * FROM licenses").all(), before);
  const extraInvite = await Effect.runPromise(remote.createInvite(owner, { hostId: HOST, role: "member" }));
  assert.equal(await outcome(remote.acceptInvite(other, extraInvite.token)), "member_limit_reached");
  assert.equal(await outcome(remote.createInvite(member, { hostId: HOST, role: "admin" })), "remote_permission_denied");
  assert.equal(
    await outcome(remote.registerHost(other, { hostId: HOST, name: "Other", ownerMembershipId: "other-member" })),
    "host_owner_mismatch",
  );
  checks.push(
    "A member can join without a paid license; configured limits, invite identity, roles, and host ownership still apply.",
  );

  database
    .prepare(`INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
    VALUES ('account-session', 'member', 'fixture-auth-hash', ?, ?, ?)`)
    .run(NOW + 3_600_000, NOW, NOW);
  assert.equal(await outcome(remote.startSession(other.id, HOST, "fixture-auth-hash")), "remote_permission_denied");
  const session = await Effect.runPromise(remote.startSession(member.id, HOST, "fixture-auth-hash"));
  const ticket = await Effect.runPromise(
    remote.issueSessionTicket(member.id, session.sessionId, "fixture-client-public-key", "fixture-auth-hash"),
  );
  const verified = await jwtVerify(ticket.ticket, keys.publicKey, {
    audience: REMOTE_TICKET_AUDIENCE,
    currentDate: new Date(NOW),
  });
  assert.equal(verified.payload.userId, member.id);
  assert.equal(verified.payload.role, "member");
  assert.equal(verified.payload.clientPublicKey, "fixture-client-public-key");
  assert.equal(ticket.signalUrl, bindings.REMOTE_SIGNAL_URL);
  await assert.rejects(
    jwtVerify(ticket.ticket, keys.publicKey, {
      audience: REMOTE_TICKET_AUDIENCE,
      currentDate: new Date(NOW + 181_000),
    }),
  );
  await Effect.runPromise(
    remote.changeMembership(owner.id, { hostId: HOST, membershipId: membership.membershipId, revoke: true }),
  );
  assert.equal(
    await outcome(remote.issueSessionTicket(member.id, session.sessionId, "fixture-client-public-key")),
    "session_inactive",
  );
  assert.equal(await outcome(remote.startSession(member.id, HOST, "fixture-auth-hash")), "remote_permission_denied");
  await Effect.runPromise(
    remote.changeMembership(owner.id, { hostId: HOST, membershipId: membership.membershipId, reactivate: true }),
  );
  const resumed = await Effect.runPromise(remote.startSession(member.id, HOST, "fixture-auth-hash"));
  database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = 'account-session'").run(NOW);
  assert.equal(
    await outcome(remote.issueSessionTicket(member.id, resumed.sessionId, "fixture-client-public-key")),
    "session_inactive",
  );
  assert.equal(await outcome(remote.startSession(member.id, HOST, "fixture-auth-hash")), "auth_session_revoked");
  checks.push(
    "Signed tickets keep their account and device claims; membership revoke/reactivate and account-session revocation remain enforced.",
  );

  assert.equal(remoteSignalPlan({ REMOTE_SIGNAL_URL: "wss://signal.openbot.run" }), null);
  assert.equal(
    remoteSignalPlan({
      REMOTE_SIGNAL_URL: bindings.REMOTE_SIGNAL_URL,
      REMOTE_SIGNAL_HOMES: "old=wss://home.openbot.run",
    }),
    null,
  );
  assert.ok(remoteSignalPlan({ REMOTE_SIGNAL_URL: bindings.REMOTE_SIGNAL_URL }));
  await Effect.runPromise(
    deliverPendingRemoteAuthEvents(
      { DB: db, REMOTE_AUTH_WEBHOOK_URL: "https://signal.openbot.run/events", REMOTE_AUTH_WEBHOOK_SECRET: SECRET },
      NOW,
      guardedFetch,
    ),
  );
  assert.equal(authEvents, 0);
  const cronBindings = {
    ...bindings,
    REMOTE_AUTH_WEBHOOK_URL: `${origin}/auth-events`,
    REMOTE_AUTH_WEBHOOK_SECRET: SECRET,
    BOAT_API_KEY: "fixture-old-boat",
    STRIPE_SECRET_KEY: "fixture-old-stripe",
    OPENPANEL_CLIENT_ID: "fixture-old-analytics",
    OPENPANEL_CLIENT_SECRET: "fixture-old-secret",
  };
  await worker.scheduled({ scheduledTime: NOW }, cronBindings);
  assert.equal(retentionRuns, 1);
  assert.equal(deliveryRuns, 1);
  assert.ok(authEvents > 0);
  assert.ok(signedEvents);
  await worker.scheduled(
    { scheduledTime: NOW, cron: SIGNAL_ENTRY_CRON },
    { ...cronBindings, REMOTE_SIGNAL_URL: "wss://signal.openbot.run" },
  );
  assert.equal(retentionRuns, 1);
  assert.equal(deliveryRuns, 1);
  assert.equal(unexpectedRequests, 0);
  checks.push(
    "Cron keeps auth retention and signed events to the owned service, and skips all original hosting, sales, and analytics requests.",
  );
  passed = true;
} finally {
  globalThis.fetch = nativeFetch;
  await server.stop(true);
  database.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "report.json"),
    JSON.stringify({ passed, checks, unexpectedRequests, authEvents, signedEvents }, null, 2),
  );
}
