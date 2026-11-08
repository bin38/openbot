import { createConnection, isIP, type Socket } from "node:net";
import { domainToASCII } from "node:url";
import { Effect, Schema } from "effect";

export interface Socks5Endpoint {
  host: string;
  port: number;
  username: string;
  password: string;
}
export interface ProxyDestination {
  host: string;
  port: number;
}
export class GeminiProxyConnectionFailure extends Schema.TaggedError<GeminiProxyConnectionFailure>()(
  "GeminiProxyConnectionFailure",
  {
    kind: Schema.Literals(["connection", "authentication", "protocol", "cancelled"]),
  },
) {}

function failure(kind: GeminiProxyConnectionFailure["kind"]): GeminiProxyConnectionFailure {
  return new GeminiProxyConnectionFailure({ kind });
}

function wait(socket: Socket, event: "connect" | "readable", signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, ready);
      socket.off("error", error);
      socket.off("end", ended);
      socket.off("close", ended);
      signal.removeEventListener("abort", aborted);
    };
    const ready = () => {
      if (event === "readable" && socket.readableLength === 0 && !socket.readableEnded && !socket.destroyed) return;
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(failure("connection"));
    };
    const ended = () => {
      cleanup();
      reject(failure("protocol"));
    };
    const aborted = () => {
      cleanup();
      reject(failure("cancelled"));
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    if (socket.destroyed || socket.readableEnded) {
      ended();
      return;
    }
    socket.on(event, ready);
    socket.once("error", error);
    socket.once("end", ended);
    socket.once("close", ended);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Readable mode leaves any first tunnel payload buffered, with Node's normal backpressure. */
async function readExactly(socket: Socket, length: number, signal: AbortSignal): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let written = 0;
  while (written < length) {
    if (signal.aborted) throw failure("cancelled");
    // Consume partial frames. Waiting with buffered bytes can re-emit readable forever on Bun.
    const value = socket.read(Math.min(length - written, socket.readableLength || 1));
    if (Buffer.isBuffer(value) && value.length > 0) {
      value.copy(result, written);
      written += value.length;
      continue;
    }
    if (value !== null && !Buffer.isBuffer(value)) throw failure("protocol");
    await wait(socket, "readable", signal);
  }
  return result;
}

function destinationBytes(destination: ProxyDestination): Buffer {
  if (isIP(destination.host) === 4) return Buffer.from([1, ...destination.host.split(".").map(Number)]);
  if (isIP(destination.host) === 6) {
    const canonical = new URL(`http://[${destination.host}]/`).hostname.slice(1, -1);
    const [left = "", right = ""] = canonical.split("::");
    const first = left ? left.split(":") : [];
    const last = right ? right.split(":") : [];
    const words = canonical.includes("::")
      ? [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last]
      : first;
    const bytes = Buffer.alloc(17);
    bytes[0] = 4;
    for (const [index, word] of words.entries()) bytes.writeUInt16BE(Number.parseInt(word, 16), 1 + index * 2);
    return bytes;
  }
  const host = domainToASCII(destination.host);
  const name = Buffer.from(host);
  if (!name.length || name.length > 255) throw failure("protocol");
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

/** Opens one SOCKS tunnel. Cancellation and failed handshakes close the owned socket. */
export const connectGeminiSocks5 = Effect.fn("GeminiSocks5.connect")(function* (
  endpoint: Socks5Endpoint,
  destination: ProxyDestination,
  timeoutMs = 10_000,
) {
  return yield* Effect.tryPromise({
    try: async (effectSignal) => {
      const signal = AbortSignal.any([effectSignal, AbortSignal.timeout(timeoutMs)]);
      const socket = createConnection({ host: endpoint.host, port: endpoint.port });
      // Error waits below own the failure; keep a listener during ownership transfer as well.
      socket.on("error", () => {});
      const aborted = () => socket.destroy();
      signal.addEventListener("abort", aborted, { once: true });
      let transferred = false;
      try {
        await wait(socket, "connect", signal);
        const username = Buffer.from(endpoint.username);
        const password = Buffer.from(endpoint.password);
        const authenticated = username.length > 0 || password.length > 0;
        if (authenticated && (!username.length || username.length > 255 || !password.length || password.length > 255))
          throw failure("authentication");
        socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]));
        const selected = await readExactly(socket, 2, signal);
        if (selected[0] !== 5 || selected[1] !== (authenticated ? 2 : 0)) throw failure("authentication");
        if (authenticated) {
          socket.write(
            Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]),
          );
          const auth = await readExactly(socket, 2, signal);
          if (auth[0] !== 1 || auth[1] !== 0) throw failure("authentication");
        }
        const port = Buffer.alloc(2);
        port.writeUInt16BE(destination.port);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0]), destinationBytes(destination), port]));
        const reply = await readExactly(socket, 4, signal);
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw failure("protocol");
        const kind = reply[3];
        if (kind === 1) await readExactly(socket, 4, signal);
        else if (kind === 4) await readExactly(socket, 16, signal);
        else if (kind === 3) {
          const length = (await readExactly(socket, 1, signal))[0];
          if (!length) throw failure("protocol");
          await readExactly(socket, length, signal);
        } else throw failure("protocol");
        await readExactly(socket, 2, signal);
        transferred = true;
        return socket;
      } finally {
        signal.removeEventListener("abort", aborted);
        if (!transferred) socket.destroy();
      }
    },
    catch: (error) => (error instanceof GeminiProxyConnectionFailure ? error : failure("connection")),
  });
});
