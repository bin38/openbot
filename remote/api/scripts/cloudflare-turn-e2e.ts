// Runs the real Signal HTTP/WebSocket service with a local credential API and throwaway signing keys.
// No account, Cloudflare, model or production endpoint is called.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeSignalServerMessage } from "@openbot/contracts/signal-protocol/decode";
import { Effect, ManagedRuntime, Result } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createRemoteApiApp } from "../src/app";
import { requestCloudflareTurnCredentials, type TurnCredentialFetch } from "../src/cloudflare-turn";
import { readRemoteApiConfig } from "../src/config";
import { SignalEntry } from "../src/entry";
import {
  REMOTE_TICKET_AUDIENCE,
  REMOTE_TICKET_PROTOCOL_VERSION,
  type SignalClientMessage,
  type SignalServerMessage,
} from "../src/protocol";
import { SignalService } from "../src/signal-service";
import { RemoteTokenService, signServiceRequest } from "../src/tokens";
import { probeTurnCredentials } from "../src/turn-probe";
import { TurnRelays } from "../src/turn-relays";

const output = resolve(import.meta.dirname, "../../..", ".openbot-build/cloudflare-turn-e2e");
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
const peers: Peer[] = [];
const apiToken = randomBytes(32).toString("base64url");
const shortUsername = "temporary-user";
const shortCredential = randomBytes(24).toString("base64url");
const webhookSecret = randomBytes(32).toString("base64url");
const requestedTtls: number[] = [];
const requests: Array<{ authorized: boolean; expectedPath: boolean }> = [];
let responseMode: "ready" | "failed" | "malformed" = "ready";
let heldResponse: { entered: () => void; release: Promise<void> } | null = null;
let currentCheck = "service setup";

class CheckError extends Error {}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

function passed(name: string) {
  checks.push({ name, passed: true });
}

function deferred() {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

async function deadline(promise: Promise<void>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new CheckError("Credential request timed out.")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class Peer {
  readonly socket: WebSocket;
  readonly messages: SignalServerMessage[] = [];
  readonly history: SignalServerMessage[] = [];
  readonly listeners = new Set<() => void>();
  closed: number | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      const message = decodeSignalServerMessage(JSON.parse(String(event.data)));
      if (!message) return;
      this.messages.push(message);
      this.history.push(message);
      for (const listener of this.listeners) listener();
    });
    this.socket.addEventListener("close", (event) => {
      this.closed = event.code;
      for (const listener of this.listeners) listener();
    });
    peers.push(this);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, reject) => {
      const timeout = setTimeout(() => reject(new CheckError("WebSocket open timed out.")), 10_000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolveOpen();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new CheckError("WebSocket open failed."));
        },
        { once: true },
      );
    });
  }

  send(message: SignalClientMessage) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolveEvent, reject) => {
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolveEvent();
      };
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new CheckError("Signal event timed out."));
      }, 10_000);
      this.listeners.add(check);
      check();
    });
  }

  async take(type: SignalServerMessage["type"]) {
    await this.waitFor(() => this.messages.some((message) => message.type === type) || this.closed !== null);
    const index = this.messages.findIndex((message) => message.type === type);
    const message = index < 0 ? undefined : this.messages.splice(index, 1)[0];
    expect(message !== undefined, "Expected Signal message did not arrive.");
    return message;
  }
}

const credentialApi = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push({
      authorized: request.headers.get("Authorization") === `Bearer ${apiToken}`,
      expectedPath:
        new URL(request.url).pathname === "/v1/turn/keys/e2e-key/credentials/generate-ice-servers" &&
        request.method === "POST",
    });
    const body: { ttl: number } = await request.json();
    requestedTtls.push(body.ttl);
    const held = heldResponse;
    heldResponse = null;
    if (held) {
      held.entered();
      await held.release;
    }
    if (responseMode === "failed") return new Response(apiToken, { status: 503 });
    if (responseMode === "malformed")
      return Response.json(
        { iceServers: [{ urls: "turn:elsewhere.invalid:3478", username: apiToken }] },
        { status: 201 },
      );
    return Response.json(
      {
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
            username: shortUsername,
            credential: shortCredential,
          },
        ],
      },
      { status: 201 },
    );
  },
});
const turnFetch: TurnCredentialFetch = (url, init) => {
  const parsed = new URL(url);
  expect(parsed.origin === "https://rtc.live.cloudflare.com", "Credential API origin changed.");
  return fetch(new URL(parsed.pathname, credentialApi.url), init);
};
const keys = await generateKeyPair("ES256", { extractable: true });
const publicKey = await exportJWK(keys.publicKey);
const config = readRemoteApiConfig({
  REMOTE_TLS_DISABLED: "true",
  REMOTE_SIGNAL_HOST: "127.0.0.1",
  REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicKey] }),
  REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1",
  REMOTE_SESSION_SECRET: randomBytes(32).toString("base64url"),
  REMOTE_AUTH_WEBHOOK_SECRET: webhookSecret,
  TURN_PROVIDER: "cloudflare",
  TURN_CLOUDFLARE_KEY_ID: "e2e-key",
  TURN_CLOUDFLARE_API_TOKEN: apiToken,
});
const tokens = new RemoteTokenService(config, () => Effect.succeed(true), { turnFetch });
const signal = new SignalService(tokens, 32, 32, 600);
const runtime = ManagedRuntime.make(signal.dependencies);
const app = createRemoteApiApp(config, signal, runtime, new TurnRelays(config), new SignalEntry(config));
app.listen({ hostname: "127.0.0.1", port: 0 });
expect(app.server !== null, "Signal HTTP listener is missing.");
const origin = `http://127.0.0.1:${app.server.port}`;
const socketUrl = `${origin.replace("http:", "ws:")}/v1/signal`;

async function ticket(role: "host" | "owner", sessionId: string, epoch = 0, expiresIn = 7_200) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    sessionId,
    hostId: "cloudflare-e2e-host",
    userId: "cloudflare-e2e-owner",
    membershipId: "cloudflare-e2e-member",
    role,
    authEpoch: epoch,
    protocolMinimum: REMOTE_TICKET_PROTOCOL_VERSION,
    protocolMaximum: REMOTE_TICKET_PROTOCOL_VERSION,
    sessionExpiresAt: now + expiresIn,
  })
    .setProtectedHeader({ alg: "ES256" })
    .setAudience(REMOTE_TICKET_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(keys.privateKey);
}

async function hello(role: "host" | "owner", sessionId: string, epoch = 0, expiresIn = 7_200) {
  const peer = new Peer(socketUrl);
  await peer.open();
  peer.send({
    type: "hello",
    version: 1,
    peer: role === "host" ? "host" : "client",
    token: await ticket(role, sessionId, epoch, expiresIn),
    multiplex: true,
  });
  return peer;
}

async function revoke(epoch: number, signed = true) {
  const body = JSON.stringify({ type: "remote-auth-changed", hostId: "cloudflare-e2e-host", authEpoch: epoch });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return fetch(`${origin}/internal/auth-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OpenBot-Timestamp": timestamp,
      "OpenBot-Signature": signed ? signServiceRequest(body, timestamp, webhookSecret) : "invalid",
    },
    body,
  });
}

async function allocationCheck() {
  const socket = createSocket("udp4");
  let allocated = false;
  let freed = false;
  const attribute = (type: number, value: Buffer) => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(type);
    header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
  };
  socket.on("message", (request, sender) => {
    const method = request.readUInt16BE(0);
    let username: string | null = null;
    let valid = false;
    for (let offset = 20; offset + 4 <= request.length; ) {
      const type = request.readUInt16BE(offset);
      const length = request.readUInt16BE(offset + 2);
      if (type === 0x0006) username = request.subarray(offset + 4, offset + 4 + length).toString();
      if (type === 0x0008) {
        const key = createHash("md5").update(`${shortUsername}:e2e:${shortCredential}`).digest();
        const expected = createHmac("sha1", key).update(request.subarray(0, offset)).digest();
        valid = username === shortUsername && expected.equals(request.subarray(offset + 4, offset + 4 + length));
      }
      offset += 4 + Math.ceil(length / 4) * 4;
    }
    const body = valid
      ? Buffer.alloc(0)
      : Buffer.concat([
          attribute(0x0009, Buffer.from([0, 0, 4, 1])),
          attribute(0x0014, Buffer.from("e2e")),
          attribute(0x0015, Buffer.from("nonce")),
        ]);
    if (valid && method === 3) allocated = true;
    if (valid && method === 4) freed = true;
    const header = Buffer.alloc(20);
    header.writeUInt16BE(method | (valid ? 0x0100 : 0x0110));
    header.writeUInt16BE(body.length, 2);
    request.copy(header, 4, 4, 20);
    socket.send(Buffer.concat([header, body]), sender.port, sender.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  try {
    await Effect.runPromise(
      probeTurnCredentials("127.0.0.1", socket.address().port, { username: shortUsername, password: shortCredential }),
    );
    expect(allocated && freed, "Issued TURN credentials did not allocate and release a relay.");
  } finally {
    socket.close();
  }
}

try {
  currentCheck = "coturn remains the default";
  const coturn = readRemoteApiConfig({
    REMOTE_TLS_DISABLED: "true",
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicKey] }),
    REMOTE_CONTROL_PLANE_URL: "http://127.0.0.1",
    REMOTE_SESSION_SECRET: randomBytes(32).toString("base64url"),
    REMOTE_AUTH_WEBHOOK_SECRET: webhookSecret,
    TURN_SHARED_SECRET: randomBytes(32).toString("base64url"),
    TURN_HOST: "127.0.0.1",
  });
  expect(!coturn.cloudflareTurn && coturn.turnSecret.length > 0, "Coturn default changed.");
  passed(currentCheck);

  currentCheck = "Cloudflare credentials and original Signal frames";
  const host = await hello("host", "host-session");
  const hostReady = await host.take("ready");
  expect(
    hostReady.type === "ready" && hostReady.iceServers.some((server) => server.credential === shortCredential),
    "Host did not receive ICE credentials.",
  );
  const client = await hello("owner", "client-session", 0, 120);
  const clientReady = await client.take("ready");
  expect(clientReady.type === "ready" && clientReady.connectionId !== null, "Client did not connect.");
  await host.take("peer-ready");
  expect(
    requestedTtls[0] === 3_600 && (requestedTtls[1] ?? 0) > 0 && (requestedTtls[1] ?? 121) <= 120,
    "TURN expiry was not bounded by the session.",
  );
  expect(
    requests.every((request) => request.authorized && request.expectedPath),
    "Credential request was invalid.",
  );
  client.send({ type: "offer", version: 1, channel: "team", connectionId: clientReady.connectionId, sdp: "e2e-offer" });
  const offer = await host.take("offer");
  expect(offer.type === "offer" && offer.sdp === "e2e-offer", "Signal relay changed.");
  passed(currentCheck);

  currentCheck = "TURN refresh reuses issued credentials";
  const before = requests.length;
  client.send({ type: "turn-refresh", version: 1, connectionId: clientReady.connectionId });
  const refreshed = await client.take("ready");
  expect(
    refreshed.type === "ready" &&
      refreshed.iceServers.some((server) => server.credential === shortCredential) &&
      requests.length === before,
    "TURN refresh did not reuse credentials.",
  );
  passed(currentCheck);

  currentCheck = "signed revocation wins during credential issuance";
  expect((await revoke(1, false)).status === 401, "Unsigned revocation was accepted.");
  const entered = deferred();
  const release = deferred();
  heldResponse = { entered: entered.resolve, release: release.promise };
  const pending = await hello("owner", "pending-session");
  try {
    await deadline(entered.promise);
    expect((await revoke(1)).status === 204, "Signed revocation failed.");
  } finally {
    release.resolve();
  }
  const rejected = await pending.take("error");
  expect(
    rejected.type === "error" &&
      rejected.code === "authentication_required" &&
      !pending.history.some((message) => message.type === "ready"),
    "Revoked peer became ready.",
  );
  await host.waitFor(() => host.closed !== null);
  await client.waitFor(() => client.closed !== null);
  passed(currentCheck);

  currentCheck = "reconnect with a new authorization epoch";
  const newHost = await hello("host", "host-session-new", 1);
  await newHost.take("ready");
  const newClient = await hello("owner", "client-session-new", 1);
  await newClient.take("ready");
  await newHost.take("peer-ready");
  passed(currentCheck);

  currentCheck = "API outage preserves retry and hides secrets";
  responseMode = "failed";
  const failed = await hello("owner", "failed-session", 1);
  await failed.waitFor(() => failed.closed !== null);
  expect(failed.closed === 1013 && failed.history.length === 0, "API outage was not retryable.");
  expect(
    !JSON.stringify(peers.flatMap((peer) => peer.history)).includes(apiToken),
    "Long-lived TURN token escaped to Signal.",
  );
  passed(currentCheck);

  currentCheck = "malformed ICE response fails safely";
  responseMode = "malformed";
  const rejectedIce = await Effect.runPromise(
    requestCloudflareTurnCredentials({ keyId: "e2e-key", apiToken }, 60, turnFetch).pipe(Effect.result),
  );
  expect(
    Result.isFailure(rejectedIce) && !JSON.stringify(rejectedIce).includes(apiToken),
    "Malformed response exposed a credential.",
  );
  passed(currentCheck);

  currentCheck = "real TURN allocation uses issued credentials and releases them";
  await allocationCheck();
  passed(currentCheck);
} catch (error) {
  checks.push({
    name: currentCheck,
    passed: false,
    detail: error instanceof CheckError ? error.message : "Service operation failed.",
  });
  process.exitCode = 1;
} finally {
  for (const peer of peers) peer.socket.close();
  await signal.close();
  await app.stop(true);
  await runtime.dispose();
  await credentialApi.stop(true);
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify({ passed: checks.every((check) => check.passed), checks }, null, 2)}\n`,
  );
  // Machine-readable: only the report path and counts leave this script.
  process.stdout.write(
    `${JSON.stringify({
      report: resolve(output, "report.json"),
      checks: checks.length,
      passed: checks.every((check) => check.passed),
    })}\n`,
  );
}
