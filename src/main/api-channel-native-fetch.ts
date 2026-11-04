import { Readable } from "node:stream";
import { sourceText } from "@openbot/i18n/source";
import { type ClientRequest, net } from "electron";
import type { ApiChannelFetch, ApiChannelRequestInit } from "./api-channel-http";

const requestError = () => new Error(sourceText("error.apiChannel.request"));

/**
 * Electron 44 net.fetch pipes request bodies into a default ClientRequest, which buffers them.
 * A native request with chunkedEncoding enabled sends each multipart chunk through Chromium's
 * data pipe. Small/non-stream bodies retain the existing net.fetch behavior and system proxy.
 */
export const apiChannelNativeFetch: ApiChannelFetch = (url, init) =>
  init.body instanceof ReadableStream ? streamRequest(url, init, init.body) : net.fetch(url, init);

function createUploadRequest(url: string, init: ApiChannelRequestInit): ClientRequest {
  const request = net.request({
    url,
    method: init.method ?? "POST",
    credentials: "omit",
    useSessionCookies: false,
    redirect: "manual",
  });
  try {
    // Set before any write: otherwise Electron selects its whole-body buffering stream.
    request.chunkedEncoding = true;
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    return request;
  } catch {
    request.abort();
    throw requestError();
  }
}

async function streamRequest(
  url: string,
  init: ApiChannelRequestInit,
  body: ReadableStream<unknown>,
): Promise<Response> {
  const reader = body.getReader();
  if (init.signal?.aborted) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw requestError();
  }
  let request: ClientRequest;
  try {
    request = createUploadRequest(url, init);
  } catch {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw requestError();
  }

  const result = Promise.withResolvers<Response>();
  const uploaded = Promise.withResolvers<void>();
  let failed = false;
  let redirected = false;
  let stopped = false;
  let uploadEnded = false;
  let responseReady = false;
  let responseEnded = false;
  let responseStream: Readable | null = null;
  let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let sourceCancelled: Promise<void> | undefined;

  function stopSource(): Promise<void> {
    stopped = true;
    if (!uploadEnded) sourceCancelled ??= reader.cancel().catch(() => undefined);
    return sourceCancelled ?? Promise.resolve();
  }
  function detachSignalWhenDone(): void {
    if (uploadEnded && (failed || redirected || responseEnded)) init.signal?.removeEventListener("abort", onAbort);
  }
  function fail(): void {
    if (failed || redirected) return;
    failed = true;
    void stopSource();
    request.abort();
    if (!responseEnded) {
      responseEnded = true;
      responseStream?.destroy();
      responseController?.error(requestError());
    }
    // Do not release borrowed file handles upstream until the body generator has settled.
    void uploaded.promise.then(() => result.reject(requestError()));
    detachSignalWhenDone();
  }
  function onAbort(): void {
    fail();
  }
  function finishResponse(): void {
    if (responseEnded) return;
    responseEnded = true;
    responseController?.close();
    detachSignalWhenDone();
  }
  function deliver(response: Response): void {
    responseReady = true;
    void stopSource();
    void uploaded.promise.then(() => {
      if (!failed) result.resolve(response);
    });
  }

  // After headers arrive, the IncomingMessage's error event owns response failures. An early
  // HTTP refusal can independently close the upload side without invalidating its response.
  request.on("error", () => {
    if (!responseReady) fail();
  });
  request.on("abort", () => {
    if (!redirected && !responseEnded) fail();
  });
  // ClientRequest is also a Writable. Its upload-side close need not mean that the native
  // response has ended; native errors, response events and the operation signal own that state.
  request.on("close", detachSignalWhenDone);
  request.on("redirect", (statusCode) => {
    // Never follow a redirect or forward a credential. The caller receives only its HTTP status.
    if (failed || responseReady || redirected) return;
    redirected = true;
    responseEnded = true;
    void stopSource();
    request.abort();
    try {
      deliver(new Response(null, { status: statusCode }));
    } catch {
      void uploaded.promise.then(() => result.reject(requestError()));
    }
    detachSignalWhenDone();
  });
  request.on("response", (incoming) => {
    if (failed || redirected) return;
    // Electron's runtime IncomingMessage extends Node Readable, although its public declaration
    // exposes only events. Check the actual boundary instead of asserting an incompatible type.
    if (!(incoming instanceof Readable)) {
      fail();
      return;
    }
    responseStream = incoming;
    incoming.pause();
    incoming.once("end", finishResponse);
    incoming.once("error", fail);
    incoming.once("aborted", fail);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          const bytes = [...item].some((character) => character.charCodeAt(0) > 255)
            ? Buffer.from(item, "utf8").toString("latin1")
            : item;
          headers.append(name, bytes);
        }
      }
      const emptyBody = init.method === "HEAD" || [204, 205, 304].includes(incoming.statusCode);
      const stream = emptyBody
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              responseController = controller;
              incoming.on("data", (chunk: unknown) => {
                if (responseEnded) return;
                if (!(chunk instanceof Uint8Array)) {
                  fail();
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
              });
            },
            pull() {
              if (!responseEnded) incoming.resume();
            },
            async cancel() {
              responseEnded = true;
              void stopSource();
              request.abort();
              incoming.destroy();
              await uploaded.promise;
              detachSignalWhenDone();
            },
          });
      if (emptyBody) incoming.resume();
      deliver(new Response(stream, { status: incoming.statusCode, statusText: incoming.statusMessage, headers }));
    } catch {
      fail();
    }
  });
  init.signal?.addEventListener("abort", onAbort, { once: true });
  if (init.signal?.aborted) fail();

  const write = (chunk: Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const failedWrite = () => {
        clear();
        reject(requestError());
      };
      const completedWrite = (error?: Error) => {
        clear();
        if (error) reject(requestError());
        else resolve();
      };
      const clear = () => {
        request.removeListener("error", failedWrite);
        request.removeListener("abort", failedWrite);
        request.removeListener("close", failedWrite);
      };
      if (failed || redirected) {
        reject(requestError());
        return;
      }
      request.once("error", failedWrite);
      request.once("abort", failedWrite);
      request.once("close", failedWrite);
      try {
        request.write(Buffer.from(chunk), undefined, completedWrite);
      } catch {
        failedWrite();
      }
    });
  void (async () => {
    try {
      while (!stopped) {
        const next = await reader.read();
        if (stopped || next.done) break;
        if (!(next.value instanceof Uint8Array)) throw requestError();
        await write(next.value);
      }
      if (!failed && !redirected) request.end();
    } catch {
      // An early HTTP response can close its upload side. Keep that response if its own stream
      // is still healthy; an actual native request/response error goes through fail().
      if (!responseReady || !stopped) fail();
    } finally {
      await sourceCancelled;
      reader.releaseLock();
      uploadEnded = true;
      uploaded.resolve();
      detachSignalWhenDone();
    }
  })();
  return result.promise;
}
