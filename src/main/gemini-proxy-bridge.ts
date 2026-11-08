import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  Agent,
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request as requestHttp,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";
import type { GeminiProxySettings } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValues } from "@openbot/logging";
import { Effect, Schema, Semaphore } from "effect";
import type { GeminiProxyRuntimeConfig } from "./gemini-proxy-settings-store";
import { connectGeminiSocks5, type ProxyDestination, type Socks5Endpoint } from "./gemini-socks5-connection";

const logger = createOpenBotLogger("gemini-proxy");
const SNAPSHOT_LIMIT = 64;
export class GeminiProxyBridgeFailure extends Schema.TaggedError<GeminiProxyBridgeFailure>()(
  "GeminiProxyBridgeFailure",
  {
    message: Schema.String,
  },
) {}
interface Snapshot {
  authorization: Buffer;
  endpoint: Socks5Endpoint;
  url: string;
}
interface ProxyPeer {
  readonly destroyed: boolean;
  once(event: "close", listener: () => void): void;
  off(event: "close", listener: () => void): void;
}

function destination(host: string, port: number): ProxyDestination | null {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ascii = isIP(unwrapped) ? unwrapped : domainToASCII(unwrapped);
  if (!ascii || /[\s/@?#\\]/u.test(ascii) || port < 1 || port > 65_535 || !Number.isInteger(port)) return null;
  return { host: ascii, port };
}
function connectDestination(value: string): ProxyDestination | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(value);
  return match?.[1] && match[2] ? destination(match[1], Number(match[2])) : null;
}
function deny(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=OpenBot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

/**
 * Loopback HTTP proxy for Gemini's HTTP clients. Each local token owns an immutable upstream
 * configuration. An active provider turn can finish with its old token after a settings edit.
 * Tokens and upstream credentials remain in this process and are discarded at app shutdown.
 */
export class GeminiProxyBridge {
  #server: Server | null = null;
  #port: number | null = null;
  #runtime: GeminiProxySettings = { enabled: false, proxyUrl: "http://127.0.0.1:7897" };
  #fingerprint: string | null = null;
  readonly #snapshots: Snapshot[] = [];
  readonly #sockets = new Set<Duplex>();
  readonly #requests = new Set<Promise<void>>();
  #closed = false;
  #unavailable = true;
  readonly #updates = Semaphore.makeUnsafe(1);
  constructor(private readonly options: { handshakeTimeoutMs?: number } = {}) {}

  runtimeSettings(): GeminiProxySettings {
    if (this.#closed || this.#unavailable) throw new Error(sourceText("error.provider.geminiProxyUnavailable"));
    return { ...this.#runtime };
  }

  readonly prepare = Effect.fn("GeminiProxyBridge.prepare")(function* (
    this: GeminiProxyBridge,
    config: GeminiProxyRuntimeConfig,
  ) {
    yield* this.#updates.withPermit(
      this.#configure(config).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.#unavailable = true;
          }),
        ),
      ),
    );
  }).bind(this);

  readonly #configure = Effect.fn("GeminiProxyBridge.configure")(function* (
    this: GeminiProxyBridge,
    config: GeminiProxyRuntimeConfig,
  ) {
    if (this.#closed)
      return yield* new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyUnavailable") });
    registerSecretValues([config.username, config.password]);
    const fingerprint = JSON.stringify(config);
    if (this.#fingerprint === fingerprint) {
      this.#unavailable = false;
      return;
    }
    if (!config.enabled || !config.proxyUrl.startsWith("socks5:")) {
      this.#runtime = { enabled: config.enabled, proxyUrl: config.proxyUrl };
      this.#fingerprint = fingerprint;
      this.#unavailable = false;
      return;
    }
    if (this.#snapshots.length >= SNAPSHOT_LIMIT)
      return yield* new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyRestartRequired") });
    if (!this.#server) yield* this.#listen();
    const upstream = new URL(config.proxyUrl);
    const endpoint = {
      host: upstream.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(upstream.port || 1080),
      username: config.username,
      password: config.password,
    };
    const token = randomBytes(32).toString("hex");
    const authorization = `Basic ${Buffer.from(`openbot:${token}`).toString("base64")}`;
    const url = `http://openbot:${token}@127.0.0.1:${this.#port}`;
    registerSecretValues([token, authorization, url]);
    this.#snapshots.push({ authorization: Buffer.from(authorization), endpoint, url });
    this.#runtime = { enabled: true, proxyUrl: url };
    this.#fingerprint = fingerprint;
    this.#unavailable = false;
  }).bind(this);

  readonly #listen = Effect.fn("GeminiProxyBridge.listen")(function* (this: GeminiProxyBridge) {
    const server = createServer((request, response) => {
      this.#run(this.#handleHttp(request, response), () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
    });
    server.headersTimeout = 10_000;
    server.on("connection", (socket) => this.#own(socket));
    server.on("connect", (request, socket, head) => {
      this.#run(this.#handleConnect(request, socket, head), () => {
        if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const error = () =>
            reject(new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyUnavailable") }));
          server.once("error", error);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", error);
            resolve();
          });
        }),
      catch: () => new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyUnavailable") }),
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          server.close(() => {});
        }),
      ),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      return yield* new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyUnavailable") });
    }
    this.#server = server;
    this.#port = address.port;
    server.on("error", () => logger.warn("The local Gemini proxy listener failed."));
  }).bind(this);

  #run<E>(operation: Effect.Effect<void, E>, failed: () => void): void {
    const pending = Effect.runPromise(operation).catch(failed);
    this.#requests.add(pending);
    void pending.then(
      () => {
        this.#requests.delete(pending);
      },
      () => {
        this.#requests.delete(pending);
      },
    );
  }

  #own(socket: Duplex): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("error", () => {});
  }
  #authenticate(request: IncomingMessage): Snapshot | null {
    const header = request.headers["proxy-authorization"];
    if (typeof header !== "string" || header.length > 512) return null;
    const value = Buffer.from(header);
    for (const snapshot of this.#snapshots)
      if (value.length === snapshot.authorization.length && timingSafeEqual(value, snapshot.authorization))
        return snapshot;
    return null;
  }

  readonly #open = Effect.fn("GeminiProxyBridge.open")(function* (
    this: GeminiProxyBridge,
    snapshot: Snapshot,
    target: ProxyDestination,
    client: ProxyPeer,
  ) {
    const disconnected = Effect.callback<never>((resume) => {
      const cancel = () => resume(Effect.interrupt);
      if (client.destroyed) {
        cancel();
        return;
      }
      client.once("close", cancel);
      return Effect.sync(() => client.off("close", cancel));
    });
    return yield* connectGeminiSocks5(snapshot.endpoint, target, this.options.handshakeTimeoutMs).pipe(
      Effect.raceFirst(disconnected),
      Effect.tapError((error) =>
        Effect.sync(() => logger.warn("A Gemini SOCKS proxy connection failed.", { kind: error.kind })),
      ),
      Effect.tap((upstream) =>
        Effect.sync(() => {
          this.#own(upstream);
          if (client.destroyed) upstream.destroy();
          else client.once("close", () => upstream.destroy());
        }),
      ),
    );
  }).bind(this);

  readonly #handleConnect = Effect.fn("GeminiProxyBridge.connect")(function* (
    this: GeminiProxyBridge,
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ) {
    const snapshot = this.#authenticate(request);
    if (!snapshot) {
      deny(client);
      return;
    }
    const target = connectDestination(request.url ?? "");
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = yield* this.#open(snapshot, target, client);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.once("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }).bind(this);

  readonly #handleHttp = Effect.fn("GeminiProxyBridge.http")(function* (
    this: GeminiProxyBridge,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const snapshot = this.#authenticate(request);
    if (!snapshot) {
      response.writeHead(407, { "proxy-authenticate": "Basic realm=OpenBot", connection: "close" });
      response.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const target = destination(url.hostname, Number(url.port || 80));
    if (url.protocol !== "http:" || url.username || url.password || !target) {
      response.writeHead(400);
      response.end();
      return;
    }
    const socket = yield* this.#open(snapshot, target, response);
    if (response.destroyed) {
      socket.destroy();
      return;
    }
    const agent = new Agent();
    agent.createConnection = () => socket;
    const headers: OutgoingHttpHeaders = { ...request.headers, host: url.host };
    const connectionHeaders = String(request.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    for (const name of [
      ...connectionHeaders,
      "proxy-authorization",
      "proxy-connection",
      "connection",
      "keep-alive",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ])
      if (name) delete headers[name];
    const outgoing = requestHttp(
      {
        hostname: target.host,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.once("error", () => response.destroy());
        incoming.pipe(response);
      },
    );
    outgoing.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.once("aborted", () => outgoing.destroy());
    response.once("close", () => {
      outgoing.destroy();
      agent.destroy();
      socket.destroy();
    });
    request.pipe(outgoing);
  }).bind(this);

  readonly close = Effect.fn("GeminiProxyBridge.close")(function* (this: GeminiProxyBridge) {
    yield* this.#updates.withPermit(this.#shutdown());
  }).bind(this);

  readonly #shutdown = Effect.fn("GeminiProxyBridge.shutdown")(function* (this: GeminiProxyBridge) {
    this.#closed = true;
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#snapshots.length = 0;
    this.#fingerprint = null;
    if (server)
      yield* Effect.tryPromise({
        try: () => new Promise<void>((resolve) => server.close(() => resolve())),
        catch: () => new GeminiProxyBridgeFailure({ message: sourceText("error.provider.geminiProxyUnavailable") }),
      });
    while (this.#requests.size) yield* Effect.promise(() => Promise.allSettled([...this.#requests]));
  }).bind(this);
}
