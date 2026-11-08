// Real loopback HTTP/CONNECT -> authenticated SOCKS5, with encrypted preference storage.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger, teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { GeminiProxyBridge } from "../src/main/gemini-proxy-bridge";
import { GeminiProxySettingsStore } from "../src/main/gemini-proxy-settings-store";

const logger = createOpenBotLogger("gemini-socks5-e2e");
const sharedCredential = "fixture-shared-credential";
const output = resolve(".openbot-build/gemini-socks5-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-gemini-socks-"));
const checks: string[] = [];
const progressFile = join(root, "progress.json");
function checked(message: string): void {
  checks.push(message);
  writeFileSync(progressFile, JSON.stringify({ phase: message, checksCompleted: checks.length }));
}
const diagnostics: string[] = [];
const detachDiagnostics = teeLogLines(["gemini-proxy"], (line) => diagnostics.push(line));
const peers = new Set<Socket>();
let originRequests = 0;
let socksConnections = 0;
let acceptedCredentials = 0;
const socksOutboundPorts = new Set<number>();
const destinationTypes = new Set<number>();
let holdGreeting: (() => void) | null = null;
let greetingObserved: (() => void) | null = null;
let boundKind: "ipv4" | "ipv6" | "domain" = "ipv4";
let passed = false;
const key = randomBytes(32);
const cipher = {
  encrypt(value: string): Buffer {
    const iv = randomBytes(12);
    const encoder = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([encoder.update(value, "utf8"), encoder.final()]);
    return Buffer.concat([iv, encoder.getAuthTag(), encrypted]);
  },
  decrypt(value: Buffer): string {
    const decoder = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decoder.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString("utf8");
  },
};
const own = (socket: Socket) => {
  socket.setTimeout(5000, () => socket.destroy(new Error("Fixture socket deadline exceeded.")));
  peers.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => peers.delete(socket));
  return socket;
};

async function bytes(socket: Socket, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = socket.read(Math.min(length - read, socket.readableLength || 1));
    if (Buffer.isBuffer(result) && result.length > 0) {
      result.copy(buffer, read);
      read += result.length;
      continue;
    }
    if (socket.destroyed || socket.readableEnded) throw new Error("Fixture peer ended early.");
    await new Promise<void>((done, fail) => {
      const cleanup = () => {
        socket.off("readable", ready);
        socket.off("close", closed);
        socket.off("error", error);
      };
      const ready = () => {
        if (socket.readableLength === 0 && !socket.readableEnded && !socket.destroyed) return;
        cleanup();
        done();
      };
      const closed = () => {
        cleanup();
        fail(new Error("Fixture peer closed."));
      };
      const error = () => {
        cleanup();
        fail(new Error("Fixture peer failed."));
      };
      socket.on("readable", ready);
      socket.once("close", closed);
      socket.once("error", error);
    });
  }
  return buffer;
}
async function listen(server: Server | HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server: Server | HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done) => server.close(() => done()));
}
async function fragmented(socket: Socket, value: Buffer): Promise<void> {
  for (const byte of value)
    await new Promise<void>((done, fail) =>
      socket.write(Buffer.from([byte]), (error) => (error ? fail(error) : done())),
    );
}
const socks = createServer((peer) => {
  own(peer);
  socksConnections += 1;
  void (async () => {
    const greeting = await bytes(peer, 2);
    assert.equal(greeting[0], 5);
    assert.equal(greeting[1], 1);
    const method = (await bytes(peer, 1))[0];
    if (holdGreeting) {
      greetingObserved?.();
      await new Promise<void>((done) => {
        holdGreeting = done;
      });
    }
    await fragmented(peer, Buffer.from([5, method === 2 ? 2 : 0]));
    if (method === 2) {
      assert.equal((await bytes(peer, 1))[0], 1);
      const usernameLength = (await bytes(peer, 1))[0];
      assert.ok(usernameLength);
      const username = (await bytes(peer, usernameLength)).toString();
      const passwordLength = (await bytes(peer, 1))[0];
      assert.ok(passwordLength);
      const password = (await bytes(peer, passwordLength)).toString();
      if (username !== sharedCredential || password !== sharedCredential) {
        await fragmented(peer, Buffer.from([1, 1]));
        peer.end();
        return;
      }
      acceptedCredentials += 1;
      await fragmented(peer, Buffer.from([1, 0]));
    }
    const command = await bytes(peer, 4);
    assert.deepEqual([...command.subarray(0, 3)], [5, 1, 0]);
    if (command[3]) destinationTypes.add(command[3]);
    let host: string;
    if (command[3] === 1) host = [...(await bytes(peer, 4))].join(".");
    else if (command[3] === 3) {
      const n = (await bytes(peer, 1))[0];
      assert.ok(n);
      host = (await bytes(peer, n)).toString();
    } else if (command[3] === 4) {
      const address = await bytes(peer, 16);
      host = Array.from({ length: 8 }, (_, i) => address.readUInt16BE(i * 2).toString(16)).join(":");
    } else throw new Error("Fixture address type refused.");
    const port = (await bytes(peer, 2)).readUInt16BE();
    const mappedHost = host === "fixture.invalid" || host === "0:0:0:0:0:0:0:1" ? "127.0.0.1" : host;
    const remote = own(createConnection({ host: mappedHost, port }));
    await once(remote, "connect");
    if (remote.localPort) socksOutboundPorts.add(remote.localPort);
    const bound =
      boundKind === "ipv4"
        ? Buffer.from([1, 127, 0, 0, 1])
        : boundKind === "ipv6"
          ? Buffer.from([4, ...Array<number>(15).fill(0), 1])
          : Buffer.concat([Buffer.from([3, 9]), Buffer.from("localhost")]);
    await fragmented(peer, Buffer.concat([Buffer.from([5, 0, 0]), bound, Buffer.from([0, 1])]));
    peer.once("close", () => remote.destroy());
    remote.once("close", () => peer.destroy());
    remote.pipe(peer);
    peer.pipe(remote);
  })().catch(() => peer.destroy());
});
const origin = createHttpServer((request, response) => {
  originRequests += 1;
  const hash = createHash("sha256");
  request.on("error", () => {});
  request.on("data", (chunk: Buffer) => hash.update(chunk));
  request.once("end", () =>
    response.end(
      JSON.stringify({
        hash: hash.digest("hex"),
        proxyAuthorizationReachedOrigin: request.headers["proxy-authorization"] !== undefined,
        arrivedThroughSocks: socksOutboundPorts.has(request.socket.remotePort ?? 0),
      }),
    ),
  );
});
const echo = createServer((peer) => {
  own(peer);
  peer.write("ready:");
  peer.pipe(peer);
});
const bridge = new GeminiProxyBridge({ handshakeTimeoutMs: 1500 });

function authorization(proxy: string): string {
  const u = new URL(proxy);
  return `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
}
async function proxyHttp(
  proxy: string,
  target: string,
  auth: string | null = authorization(proxy),
  body = "fixture-body",
): Promise<{ status: number; body: string }> {
  const u = new URL(proxy);
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: target,
        method: "POST",
        headers: { ...(auth ? { "proxy-authorization": auth } : {}), "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("Fixture HTTP deadline exceeded.")));
    request.once("error", fail);
    request.end(body);
  });
}
async function tunnel(proxy: string, port: number, host = "127.0.0.1"): Promise<Socket> {
  const u = new URL(proxy);
  const peer = own(createConnection({ host: u.hostname, port: Number(u.port) }));
  await once(peer, "connect");
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  peer.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
  );
  let header = "";
  while (!header.endsWith("\r\n\r\n")) {
    header += (await bytes(peer, 1)).toString();
    assert.ok(header.length < 4096);
  }
  assert.ok(header.startsWith("HTTP/1.1 200"));
  return peer;
}

try {
  const socksPort = await listen(socks);
  const originPort = await listen(origin);
  const echoPort = await listen(echo);
  const path = join(root, "settings.json");
  const store = new GeminiProxySettingsStore(path, cipher);
  await Effect.runPromise(store.load());
  const address = `socks5://127.0.0.1:${socksPort}`;
  await Effect.runPromise(
    store.set({ enabled: true, proxyUrl: address, username: sharedCredential, password: sharedCredential }),
  );
  const disk = await readFile(path, "utf8");
  assert.ok(!disk.includes(sharedCredential));
  assert.ok(!JSON.stringify(store.get()).includes(sharedCredential));
  assert.equal(store.get().hasPassword, true);
  assert.equal(store.get().hasUsername, true);
  const reloaded = new GeminiProxySettingsStore(path, cipher);
  await Effect.runPromise(reloaded.load());
  assert.deepEqual(reloaded.get(), store.get());
  await Effect.runPromise(reloaded.set({ enabled: true, proxyUrl: address }));
  assert.equal(reloaded.runtimeConfig().password, sharedCredential);
  await assert.rejects(Effect.runPromise(reloaded.set({ enabled: true, proxyUrl: "socks5://127.0.0.1:1" })));
  assert.equal(reloaded.get().proxyUrl, address);
  checked(
    "Username and password, even when equal, are encrypted together and never returned; blank inputs retain the same endpoint and changed origins require new credentials.",
  );

  await Effect.runPromise(bridge.prepare(reloaded.runtimeConfig()));
  const runtime = bridge.runtimeSettings();
  assert.ok(!runtime.proxyUrl.includes(sharedCredential));
  assert.ok(runtime.proxyUrl.startsWith("http://openbot:"));
  const initial = socksConnections;
  const denied = await proxyHttp(runtime.proxyUrl, `http://127.0.0.1:${originPort}/`, null);
  assert.equal(denied.status, 407);
  assert.equal(socksConnections, initial);
  const wrongLocal = await proxyHttp(runtime.proxyUrl, `http://127.0.0.1:${originPort}/`, "Basic invalid");
  assert.equal(wrongLocal.status, 407);
  assert.equal(socksConnections, initial);
  checked("The loopback bridge requires an unpredictable local credential before it opens any upstream connection.");

  for (const kind of ["ipv4", "ipv6", "domain"] as const) {
    boundKind = kind;
    const response = await proxyHttp(runtime.proxyUrl, `http://127.0.0.1:${originPort}/fixture?case=${kind}`);
    assert.equal(response.status, 200);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.proxyAuthorizationReachedOrigin, false);
    assert.equal(parsed.arrivedThroughSocks, true);
    assert.equal(parsed.hash, createHash("sha256").update("fixture-body").digest("hex"));
  }
  checked(
    "Real HTTP requests cross fragmented SOCKS method/authentication/IPv4, IPv6 and domain replies; local authorization never reaches the origin.",
  );
  const domainHttp = await proxyHttp(runtime.proxyUrl, `http://fixture.invalid:${originPort}/remote-dns`);
  assert.equal(domainHttp.status, 200);
  assert.equal(JSON.parse(domainHttp.body).arrivedThroughSocks, true);
  for (const host of ["fixture.invalid", "::1"]) {
    const peer = await tunnel(runtime.proxyUrl, echoPort, host);
    assert.equal((await bytes(peer, 6)).toString(), "ready:");
    peer.write("mapped");
    assert.equal((await bytes(peer, 6)).toString(), "mapped");
    peer.destroy();
  }
  assert.deepEqual([...destinationTypes].sort(), [1, 3, 4]);
  checked(
    "IPv4, remote-resolved domain and IPv6 CONNECT destinations all traverse the SOCKS server without local origin lookup.",
  );

  const active = await tunnel(runtime.proxyUrl, echoPort);
  assert.equal((await bytes(active, 6)).toString(), "ready:");
  await Effect.runPromise(bridge.prepare({ ...reloaded.runtimeConfig(), password: "fixture-wrong-password" }));
  const failedOrigin = originRequests;
  const wrong = await proxyHttp(bridge.runtimeSettings().proxyUrl, `http://127.0.0.1:${originPort}/`);
  assert.equal(wrong.status, 502);
  assert.equal(originRequests, failedOrigin);
  const old = await proxyHttp(runtime.proxyUrl, `http://127.0.0.1:${originPort}/`);
  assert.equal(old.status, 200);
  active.write("retained");
  assert.equal((await bytes(active, 8)).toString(), "retained");
  checked(
    "Wrong upstream authentication fails closed; rotating settings preserves both an active tunnel and its old provider configuration.",
  );

  const chunk = Buffer.alloc(64 * 1024, 7);
  const expected = createHash("sha256");
  const received = createHash("sha256");
  let count = 0;
  const complete = new Promise<void>((done, fail) => {
    active.on("data", (value: Buffer) => {
      count += value.length;
      received.update(value);
      if (count === chunk.length * 32) done();
    });
    active.once("error", fail);
  });
  for (let i = 0; i < 32; i += 1) {
    expected.update(chunk);
    if (!active.write(chunk)) await once(active, "drain");
  }
  await complete;
  assert.equal(received.digest("hex"), expected.digest("hex"));
  active.destroy();
  checked("A 2 MiB CONNECT payload streams intact with backpressure after an upstream configuration change.");

  const free = createServer();
  const closedPort = await listen(free);
  await close(free);
  await Effect.runPromise(
    bridge.prepare({ ...reloaded.runtimeConfig(), proxyUrl: `socks5://127.0.0.1:${closedPort}` }),
  );
  const beforeUnavailable = originRequests;
  assert.equal((await proxyHttp(bridge.runtimeSettings().proxyUrl, `http://127.0.0.1:${originPort}/`)).status, 502);
  assert.equal(originRequests, beforeUnavailable);
  checked("An unavailable SOCKS proxy produces a gateway failure without connecting directly to the origin.");
  assert.ok(diagnostics.every((line) => !line.includes(sharedCredential) && !line.includes("fixture-wrong-password")));

  const capacity = new GeminiProxyBridge();
  assert.throws(() => capacity.runtimeSettings());
  try {
    for (let i = 0; i < 64; i += 1)
      await Effect.runPromise(
        capacity.prepare({
          ...reloaded.runtimeConfig(),
          password: i === 0 ? sharedCredential : `fixture-rotation-${i}`,
        }),
      );
    await assert.rejects(
      Effect.runPromise(capacity.prepare({ ...reloaded.runtimeConfig(), password: "fixture-over-capacity" })),
    );
    assert.throws(() => capacity.runtimeSettings());
  } finally {
    await Effect.runPromise(capacity.close());
  }
  checked("An unprepared or failed bridge blocks fresh provider settings instead of exposing a stale or direct route.");

  await Effect.runPromise(bridge.prepare(reloaded.runtimeConfig()));
  const greeting = new Promise<void>((done) => {
    greetingObserved = done;
  });
  holdGreeting = () => {};
  const u = new URL(bridge.runtimeSettings().proxyUrl);
  const request = httpRequest({
    hostname: u.hostname,
    port: u.port,
    path: `http://127.0.0.1:${originPort}/`,
    headers: { "proxy-authorization": authorization(u.href) },
  });
  request.on("error", () => {});
  request.end();
  await greeting;
  const waitingPeers = [...peers].filter((peer) => peer.remotePort !== undefined);
  const stopped = Promise.all(
    waitingPeers.filter((peer) => peer.localPort === socksPort).map((peer) => once(peer, "close")),
  );
  request.destroy();
  await stopped;
  holdGreeting?.();
  holdGreeting = null;
  greetingObserved = null;
  checked("Closing the local client interrupts a pending SOCKS handshake and closes its upstream socket.");

  await Effect.runPromise(reloaded.set({ enabled: false, proxyUrl: address, clearPassword: true }));
  assert.equal(reloaded.get().hasPassword, undefined);
  assert.equal(reloaded.get().hasUsername, undefined);
  const legacyPath = join(root, "legacy.json");
  await writeFile(
    legacyPath,
    JSON.stringify({ version: 1, settings: { enabled: true, proxyUrl: "http://127.0.0.1:7897" } }),
  );
  const legacy = new GeminiProxySettingsStore(legacyPath);
  await Effect.runPromise(legacy.load());
  await Effect.runPromise(bridge.prepare(legacy.runtimeConfig()));
  assert.deepEqual(bridge.runtimeSettings(), legacy.get());
  checked(
    "Explicit clearing removes both credentials; existing unauthenticated HTTP preference files keep their original behavior.",
  );
  const closing = await tunnel(runtime.proxyUrl, echoPort);
  assert.equal((await bytes(closing, 6)).toString(), "ready:");
  const closed = once(closing, "close");
  await Effect.runPromise(bridge.close());
  await closed;
  assert.throws(() => bridge.runtimeSettings());
  checked("App shutdown closes active tunnels, waits for owned requests and discards local authentication snapshots.");
  passed = true;
} finally {
  holdGreeting?.();
  await Effect.runPromise(bridge.close());
  detachDiagnostics();
  for (const peer of peers) peer.destroy();
  await Promise.all([close(socks), close(origin), close(echo)]);
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, acceptedCredentials, originRequests, diagnosticEntries: diagnostics.length }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
  logger.info("Gemini SOCKS5 checks finished.", { passed, checks: checks.length });
}
