// Runs the deployed entry in local workerd with real D1, R2, native email capture, and HTTP.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { REMOTE_TICKET_AUDIENCE } from "@openbot/contracts/signal-protocol/ticket";
import { createOpenBotLogger } from "@openbot/logging";
import { build } from "esbuild";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { type JSONType, z } from "zod";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build/independent-account-worker-e2e");
const OWNER = "owner@example.test";
const MEMBER = "member@example.test";
const SENDER = "no-reply@mail.example.test";
const SECRET = "local-workerd-only-auth-events-key";
const HOST = "fixture-host";
const DEVICE_IDS = { phone: randomUUID(), replay: randomUUID(), link: randomUUID() };
const logger = createOpenBotLogger("independent-account-worker-e2e");
const checks: string[] = [];
let passed = false;
let unexpectedOutbound = 0;
let signedEvents = 0;
let outboundAttempts = 0;
let invalidSignatures = 0;
let revokedSessionId: string | null = null;
const revocationDelivered = Promise.withResolvers<void>();
let runtime: Miniflare | undefined;
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "fixture-1", alg: "ES256", use: "sig" };
const hostPublicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString()
  .trim();
const fingerprint = createHash("sha256").update(hostPublicKey).digest("base64url");
const sessionSchema = z.object({ sessionToken: z.string(), user: z.object({ id: z.string(), email: z.string() }) });
const ticketSchema = z.object({ ticket: z.string(), signalUrl: z.string() });

try {
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  const bundle = join(OUT, "worker.mjs");
  const compiled = await build({
    entryPoints: [join(ROOT, "apps/auth-api/src/independent-worker-entry.ts")],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    minify: true,
    logLevel: "silent",
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await writeFile(join(OUT, "bundle-metafile.json"), `${JSON.stringify(compiled.metafile, null, 2)}\n`);
  const code = await readFile(bundle);
  const bundleBytes = code.byteLength;
  const compressedBytes = gzipSync(code).byteLength;
  await writeFile(join(OUT, "bundle-size.json"), `${JSON.stringify({ bundleBytes, compressedBytes }, null, 2)}\n`);
  assert.ok(compressedBytes < 3 * 1024 * 1024, "The account Worker fits the Workers Free upload limit.");
  const options = {
    name: "independent-account-fixture",
    scriptPath: bundle,
    modules: true,
    compatibilityDate: "2026-08-18",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 0,
    cf: false,
    log: new Log(LogLevel.ERROR),
    unsafeLocalExplorer: true,
    d1Databases: ["DB"],
    r2Buckets: ["AVATARS"],
    email: {
      send_email: [
        { name: "EMAIL", allowed_destination_addresses: [OWNER, MEMBER], allowed_sender_addresses: [SENDER] },
      ],
    },
    bindings: {
      AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
      AUTH_ALLOWED_EMAILS: `${OWNER},${MEMBER}`,
      EMAIL_FROM: SENDER,
      REMOTE_TICKET_KEY_ID: "fixture-1",
      REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...pair.privateKey.export({ format: "jwk" }), kid: "fixture-1" }),
      REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      REMOTE_SIGNAL_URL: "wss://signal.example.test/v1/signal",
      REMOTE_AUTH_WEBHOOK_URL: "https://signal.example.test/internal/auth-events",
      REMOTE_AUTH_WEBHOOK_SECRET: SECRET,
    },
    outboundService: async (request) => {
      outboundAttempts += 1;
      const url = new URL(request.url);
      if (url.origin !== "https://signal.example.test" || url.pathname !== "/internal/auth-events") {
        unexpectedOutbound += 1;
        return new Response(null, { status: 503 });
      }
      const body = await request.text();
      const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
      const expected = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("base64url");
      if (request.headers.get("OpenBot-Signature") !== expected) {
        invalidSignatures += 1;
        return new Response(null, { status: 401 });
      }
      signedEvents += 1;
      const event = z.object({ type: z.string(), sessionId: z.string().optional() }).parse(JSON.parse(body));
      if (event.type === "remote-session-ended" && event.sessionId === revokedSessionId) revocationDelivered.resolve();
      return new Response(null, { status: 204 });
    },
  } satisfies V4MiniflareOptions;
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  let base = await runtime.ready;
  const db = await runtime.getD1Database("DB");
  for (const name of (await readdir(join(ROOT, "apps/auth-api/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements = unstable_splitSqlQuery(await readFile(join(ROOT, "apps/auth-api/migrations", name), "utf8"));
    if (statements.length > 0) await db.batch(statements.map((sql) => db.prepare(sql)));
  }

  async function request(path: string, status: number, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, base), init);
    if (response.status !== status) {
      const failure = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,64}$/u) }) }).safeParse(
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      const code = failure.success ? failure.data.error.code : "unavailable";
      assert.equal(response.status, status, `${init.method ?? "GET"} ${new URL(path, base).pathname} (${code})`);
    }
    return response;
  }
  function jsonInit(method: string, body: JSONType, token?: string): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    };
  }
  function authenticated(token: string, method = "GET"): RequestInit {
    return { method, headers: { Authorization: `Bearer ${token}` } };
  }
  const mailboxPath = "/cdn-cgi/local/explorer/api/local/email/sending?worker=independent-account-fixture";
  async function signIn(email: string) {
    const startResponse = await request("/v1/auth/email/start", 200, jsonInit("POST", { email }));
    const start = z
      .object({ challengeId: z.string(), developmentCode: z.never().optional() })
      .parse(await startResponse.json());
    const emails = z
      .object({ result: z.array(z.object({ messageId: z.string(), to: z.array(z.string()) })) })
      .parse(await (await request(mailboxPath, 200)).json());
    const sent = emails.result.find((item) => item.to.includes(email));
    assert.ok(sent, "Native email was captured for the requested identity.");
    const detail = z
      .object({
        result: z.object({
          text: z.string().optional(),
          raw: z.string().optional(),
          rawBase64: z.string().optional(),
          from: z.string(),
          to: z.array(z.string()),
        }),
      })
      .parse(await (await request(`${mailboxPath}&email_id=${encodeURIComponent(sent.messageId)}`, 200)).json());
    assert.equal(detail.result.from, SENDER);
    assert.deepEqual(detail.result.to, [email]);
    const code = /\b[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}\b/u.exec(
      capturedEmailText(detail.result),
    )?.[0];
    assert.ok(code, "The real local email carries a one-time code.");
    const result = sessionSchema.parse(
      await (
        await request("/v1/auth/email/verify", 200, jsonInit("POST", { challengeId: start.challengeId, code }))
      ).json(),
    );
    await request("/v1/auth/email/verify", 401, jsonInit("POST", { challengeId: start.challengeId, code }));
    return result;
  }

  await request("/health/live", 200);
  await request("/health/ready", 200);
  await request("/v1/me", 401);
  for (const path of ["/v1/me/billing", "/v2/hosting/plans", "/pricing", "/api/browser/session", "/v1/sites/"])
    await request(path, 404);
  await request("/v1/auth/email/start", 400, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  await request("/v1/auth/email/start", 502, jsonInit("POST", { email: "outside@example.test" }));
  checks.push(
    "Only the selected native API is exposed; malformed requests and disallowed email recipients are refused.",
  );

  const owner = await signIn(OWNER);
  const member = await signIn(MEMBER);
  checks.push(
    "Native Cloudflare email transport, code verification, one-time consumption, and real desktop sessions work without development codes.",
  );
  await request("/v1/me", 200, authenticated(owner.sessionToken));
  await request("/v1/me/profile", 200, jsonInit("PATCH", { name: "本地测试用户" }, owner.sessionToken));
  await request("/v1/me/analytics", 200, jsonInit("PUT", { enabled: false, ageMs: 0 }, owner.sessionToken));
  const avatar = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const profile = z.object({ avatarUrl: z.string() }).parse(
    await (
      await request("/v1/me/avatar", 200, {
        method: "PUT",
        headers: { Authorization: `Bearer ${owner.sessionToken}`, "Content-Type": "image/png" },
        body: avatar,
      })
    ).json(),
  );
  await request(profile.avatarUrl, 200);
  await request("/v1/me/avatar", 200, authenticated(owner.sessionToken, "DELETE"));
  await request(profile.avatarUrl, 404);
  checks.push("Profile, analytics preference, and avatar upload/read/removal keep native response contracts.");

  const registered = z
    .object({ machineToken: z.string() })
    .parse(
      await (
        await request(
          "/v2/remote/hosts/register",
          201,
          jsonInit(
            "POST",
            { hostId: HOST, name: "E2E 主机", ownerMembershipId: "fixture-owner", devicePublicKey: hostPublicKey },
            owner.sessionToken,
          ),
        )
      ).json(),
    );
  await request(
    "/v2/remote/hosts/register",
    403,
    jsonInit(
      "POST",
      { hostId: HOST, name: "Refused takeover", ownerMembershipId: "other-owner", devicePublicKey: hostPublicKey },
      member.sessionToken,
    ),
  );
  const hostTicket = ticketSchema.parse(
    await (
      await request(`/v2/remote/hosts/${HOST}/ticket`, 200, jsonInit("POST", { machineToken: registered.machineToken }))
    ).json(),
  );
  const jwks = z
    .object({ keys: z.array(z.object({ kty: z.string(), kid: z.string() }).passthrough()) })
    .parse(await (await request("/.well-known/jwks.json", 200)).json());
  const keys = createLocalJWKSet(jwks);
  const hostClaims = await jwtVerify(hostTicket.ticket, keys, { audience: REMOTE_TICKET_AUDIENCE });
  assert.equal(hostClaims.payload.role, "host");
  assert.equal(hostTicket.signalUrl, "wss://signal.example.test/v1/signal");
  checks.push(
    "Host ownership cannot be replaced by another account; host tickets verify against the independent JWKS.",
  );

  const binding = { hostId: HOST, fingerprint };
  const pairing = z
    .object({ ticket: z.string() })
    .parse(
      await (
        await request("/v1/mobile-auth/ticket", 200, jsonInit("POST", { host: binding }, owner.sessionToken))
      ).json(),
    );
  const mobile = sessionSchema.parse(
    await (
      await request(
        "/v1/mobile-auth/redeem",
        200,
        jsonInit("POST", {
          ticket: pairing.ticket,
          deviceId: DEVICE_IDS.phone,
          deviceName: "测试手机",
          platform: "ios",
        }),
      )
    ).json(),
  );
  await request(
    "/v1/mobile-auth/redeem",
    401,
    jsonInit("POST", { ticket: pairing.ticket, deviceId: DEVICE_IDS.replay, deviceName: "Replay", platform: "ios" }),
  );
  await request("/v1/mobile-auth/session", 200, authenticated(mobile.sessionToken));
  const hosts = z
    .object({ hosts: z.array(z.object({ hostId: z.string() })) })
    .parse(await (await request("/v2/remote/hosts/", 200, authenticated(mobile.sessionToken))).json());
  assert.ok(hosts.hosts.some((host) => host.hostId === HOST));
  const remoteSession = z
    .object({ sessionId: z.string() })
    .parse(
      await (
        await request("/v2/remote/sessions/", 201, jsonInit("POST", { hostId: HOST }, mobile.sessionToken))
      ).json(),
    );
  const peerTicket = ticketSchema.parse(
    await (
      await request(
        `/v2/remote/sessions/${remoteSession.sessionId}/ticket`,
        200,
        jsonInit("POST", { clientPublicKey: hostPublicKey }, mobile.sessionToken),
      )
    ).json(),
  );
  const peerClaims = await jwtVerify(peerTicket.ticket, keys, { audience: REMOTE_TICKET_AUDIENCE });
  assert.equal(peerClaims.payload.clientPublicKey, hostPublicKey);
  const claims = decodeJwt(peerTicket.ticket);
  const resumeBody = JSON.stringify({
    sessionId: claims.sessionId,
    hostId: claims.hostId,
    userId: claims.userId,
    membershipId: claims.membershipId,
    role: claims.role,
    authEpoch: claims.authEpoch,
    sessionExpiresAt: claims.sessionExpiresAt,
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const resumeInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OpenBot-Timestamp": timestamp,
      "OpenBot-Signature": createHmac("sha256", SECRET).update(`${timestamp}.${resumeBody}`).digest("base64url"),
    },
    body: resumeBody,
  };
  assert.deepEqual(await (await request("/v2/remote/resume/validate", 200, resumeInit)).json(), { valid: true });
  await request("/v2/remote/resume/validate", 401, { ...resumeInit, headers: { "Content-Type": "application/json" } });
  await request(`/v2/remote/sessions/${remoteSession.sessionId}/end`, 204, authenticated(mobile.sessionToken, "POST"));
  assert.deepEqual(await (await request("/v2/remote/resume/validate", 200, resumeInit)).json(), { valid: false });
  checks.push(
    "Host-bound QR pairing, replay refusal, native directory/session tickets, signed resume, and session end work over real HTTP.",
  );

  const invite = z
    .object({ inviteId: z.string(), token: z.string() })
    .parse(
      await (
        await request(
          `/v2/remote/hosts/${HOST}/invites`,
          201,
          jsonInit("POST", { role: "member", email: MEMBER }, owner.sessionToken),
        )
      ).json(),
    );
  await request("/v2/remote/invites/preview", 200, jsonInit("POST", { token: invite.token }));
  await request("/v2/remote/invites/accept", 200, jsonInit("POST", { token: invite.token }, member.sessionToken));
  const members = z
    .object({ members: z.array(z.object({ membershipId: z.string(), email: z.string() })) })
    .parse(await (await request(`/v2/remote/hosts/${HOST}/members/`, 200, authenticated(owner.sessionToken))).json());
  const membership = members.members.find((item) => item.email === MEMBER);
  assert.ok(membership);
  await request(
    `/v2/remote/hosts/${HOST}/members/${membership.membershipId}`,
    204,
    jsonInit("PATCH", { role: "admin" }, owner.sessionToken),
  );
  await request(
    `/v2/remote/hosts/${HOST}/members/${membership.membershipId}`,
    204,
    authenticated(owner.sessionToken, "DELETE"),
  );
  await request("/v2/remote/sessions/", 403, jsonInit("POST", { hostId: HOST }, member.sessionToken));
  await request(
    `/v2/remote/hosts/${HOST}/members/${membership.membershipId}`,
    204,
    jsonInit("PATCH", { role: "member", reactivate: true }, owner.sessionToken),
  );
  await request(`/v2/remote/hosts/${HOST}/invites`, 200, authenticated(owner.sessionToken));
  checks.push("Original phone member and invite settings retain role checks, revoke, and reactivate behavior.");

  const devices = z
    .object({ devices: z.array(z.object({ sessionId: z.string() })) })
    .parse(
      await (await request(`/v1/mobile-auth/devices?host=${HOST}`, 200, authenticated(owner.sessionToken))).json(),
    );
  const device = devices.devices[0];
  assert.ok(device);
  const liveSession = z
    .object({ sessionId: z.string() })
    .parse(
      await (
        await request("/v2/remote/sessions/", 201, jsonInit("POST", { hostId: HOST }, mobile.sessionToken))
      ).json(),
    );
  revokedSessionId = liveSession.sessionId;
  await request(`/v1/mobile-auth/devices/${device.sessionId}`, 204, authenticated(owner.sessionToken, "DELETE"));
  await request("/v1/mobile-auth/session", 401, authenticated(mobile.sessionToken));
  await waitForRevocation(revocationDelivered.promise);
  const link = z
    .object({ link: z.string() })
    .parse(
      await (
        await request("/v1/mobile-auth/link", 200, jsonInit("POST", { host: binding }, owner.sessionToken))
      ).json(),
    );
  const linkedPhone = sessionSchema.parse(
    await (
      await request(
        "/v1/mobile-auth/redeem",
        200,
        jsonInit("POST", { ticket: link.link, deviceId: DEVICE_IDS.link, deviceName: "链接手机", platform: "android" }),
      )
    ).json(),
  );
  await request(`/v1/mobile-auth/link?host=${HOST}`, 204, authenticated(owner.sessionToken, "DELETE"));
  await request("/v1/mobile-auth/session", 401, authenticated(linkedPhone.sessionToken));
  await request("/v1/mobile-auth/devices?includeDesktop=true", 200, authenticated(owner.sessionToken));
  await request("/v1/auth/logout", 204, authenticated(owner.sessionToken, "POST"));
  await request("/v1/me", 401, authenticated(owner.sessionToken));
  assert.equal(unexpectedOutbound, 0);
  assert.equal(invalidSignatures, 0);
  assert.ok(signedEvents > 0, "Revocations reach only the signed fixture Signal endpoint.");
  checks.push(
    "Device revocation, permanent-link revocation, desktop logout, and signed auth event delivery invalidate access.",
  );
  await runtime.setOptions(
    convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, AUTH_EXPOSE_DEVELOPMENT_CODE: "true" } }),
  );
  base = await runtime.ready;
  await request("/health/ready", 503);
  await request("/v1/auth/email/start", 503, jsonInit("POST", { email: OWNER }));
  await runtime.setOptions(
    convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, AUTH_ALLOWED_EMAILS: "" } }),
  );
  base = await runtime.ready;
  await request("/health/ready", 503);
  checks.push("The independent entry fails closed for development-code exposure or a missing email allowlist.");
  passed = true;
} finally {
  const outbox = runtime
    ? await runtime
        .getD1Database("DB")
        .then((db) =>
          db
            .prepare("SELECT COUNT(*) AS pending, COALESCE(SUM(attempts), 0) AS attempts FROM remote_auth_events")
            .first<{ pending: number; attempts: number }>(),
        )
        .catch(() => null)
    : null;
  await runtime?.dispose();
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ passed, checks, unexpectedOutbound, outboundAttempts, invalidSignatures, signedEvents, outbox }, null, 2)}\n`,
    { mode: 0o600 },
  );
  logger.info("Independent account Worker E2E finished.", { passed, checks: checks.length });
}

/** Wait for the specific revoked session's signed event, with a failure deadline. */
async function waitForRevocation(delivered: Promise<void>): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  const timeout = Promise.withResolvers<never>();
  const expired = () => timeout.reject(new Error("The revoked session's signed auth event was not delivered."));
  signal.addEventListener("abort", expired, { once: true });
  try {
    await Promise.race([delivered, timeout.promise]);
  } finally {
    signal.removeEventListener("abort", expired);
  }
}

/** The legacy binding captures MIME; structured sends can also expose the decoded text directly. */
function capturedEmailText(email: {
  text?: string | undefined;
  raw?: string | undefined;
  rawBase64?: string | undefined;
}): string {
  if (email.text) return email.text;
  const raw = email.raw ?? (email.rawBase64 ? Buffer.from(email.rawBase64, "base64").toString("utf8") : "");
  const boundary = /^Content-Type:[^\r\n]*boundary="([^"]+)"/imu.exec(raw)?.[1];
  assert.ok(boundary, "The captured email has a MIME boundary.");
  for (const part of raw.split(`--${boundary}`)) {
    const separator = /\r?\n\r?\n/u.exec(part);
    if (!separator) continue;
    const headers = part.slice(0, separator.index);
    if (!/^Content-Type:\s*text\/plain\b/imu.test(headers)) continue;
    const body = part.slice(separator.index + separator[0].length).trim();
    assert.match(headers, /^Content-Transfer-Encoding:\s*base64\b/imu, "The plain text part uses base64.");
    return Buffer.from(body, "base64").toString("utf8");
  }
  throw new Error("The captured email has no plain text part.");
}
