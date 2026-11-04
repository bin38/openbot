import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ApiChannelDefinition, ApiChannelOperation, ApiChannelValue } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { isSecretName, redactText } from "@openbot/logging";
import { Effect } from "effect";
import type { GeneratedAttachmentSource } from "../backend/attachment-files";
import { ApiChannelFailure, apiChannelFailure, apiChannelUrl, apiValueAt, parseApiJson } from "./api-channel-schema";
import type { StoredApiArtifact } from "./api-channel-store";

export interface ApiChannelRequestInit extends RequestInit {
  duplex?: "half";
}
export type ApiChannelFetch = (url: string, init: ApiChannelRequestInit) => Promise<Response>;
type Values = Record<string, ApiChannelValue>;
const REQUEST_TIMEOUT = 120_000;
const RESPONSE_LIMIT = 32 * 1024 * 1024;
/** Borrow the gateway's descriptor without a ReadStream that can close it on cancellation. */
async function* fileChunks(file: GeneratedAttachmentSource): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield new Uint8Array(buffer.subarray(0, bytesRead));
  }
}

export function apiChannelValues(operation: ApiChannelOperation, json: string): Values {
  try {
    if (json.length > 2 * 1024 * 1024) throw apiChannelFailure("parameters");
    const supplied = parseApiJson(json);
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw apiChannelFailure("parameters");
    if (Object.keys(supplied).some((name) => !operation.parameters.some((parameter) => parameter.name === name)))
      throw apiChannelFailure("parameters");
    const result: Values = {};
    for (const parameter of operation.parameters) {
      const value = Object.hasOwn(supplied, parameter.name)
        ? supplied[parameter.name]
        : parameter.defaultJson
          ? parseApiJson(parameter.defaultJson)
          : undefined;
      if (value === undefined) {
        if (parameter.required) throw apiChannelFailure("parameters");
        continue;
      }
      if (parameter.type !== "json" && typeof value !== (parameter.type === "file" ? "string" : parameter.type))
        throw apiChannelFailure("parameters");
      result[parameter.name] = value;
    }
    return result;
  } catch {
    throw apiChannelFailure("parameters");
  }
}
function printable(value: ApiChannelValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}
function fill(value: ApiChannelValue, values: Values): ApiChannelValue {
  if (typeof value === "string") {
    const whole = /^\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}$/u.exec(value);
    if (whole) return values[whole[1] ?? ""] ?? null;
    return value.replace(/\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/gu, (_match, name: string) => printable(values[name]));
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  return value;
}
async function jsonFileValues(
  operation: ApiChannelOperation,
  values: Values,
  files: ReadonlyMap<string, GeneratedAttachmentSource>,
): Promise<Values> {
  const result = { ...values };
  let total = 0;
  for (const parameter of operation.parameters.filter((item) => item.type === "file")) {
    const file = files.get(parameter.name);
    if (!file) continue;
    const metadata = await file.handle.stat();
    total += metadata.size;
    if (!metadata.isFile() || total > 16 * 1024 * 1024) throw apiChannelFailure("file");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of fileChunks(file)) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size) throw apiChannelFailure("file");
      chunks.push(chunk);
    }
    const mime =
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".pdf": "application/pdf",
      }[extname(file.path).toLowerCase()] ?? "application/octet-stream";
    const encoded = Buffer.concat(chunks).toString("base64");
    result[parameter.name] = parameter.fileEncoding === "base64" ? encoded : `data:${mime};base64,${encoded}`;
  }
  return result;
}
export function apiOperationUrl(definition: ApiChannelDefinition, operation: ApiChannelOperation, values: Values): URL {
  const base = apiChannelUrl(definition.baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const path = operation.path.replace(/\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/gu, (_match, name: string) => {
    const value = printable(values[name]);
    if (!value || !/^[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*$/u.test(value)) throw apiChannelFailure("parameters");
    return encodeURIComponent(value);
  });
  if (path.includes("{{")) throw apiChannelFailure("parameters");
  const url = new URL(path.slice(1), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw apiChannelFailure("invalid");
  for (const pair of operation.query) {
    const value = printable(fill(pair.value, values));
    if (value !== "null" && value !== "") url.searchParams.set(pair.name, value);
  }
  return url;
}

function multipart(
  operation: ApiChannelOperation,
  values: Values,
  files: ReadonlyMap<string, GeneratedAttachmentSource>,
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const object = parseApiJson(operation.body);
  if (!object || typeof object !== "object" || Array.isArray(object)) throw apiChannelFailure("parameters");
  const fields = Object.entries(object);
  const boundary = `openbot-${randomUUID()}`;
  const encoder = new TextEncoder();
  async function* parts(): AsyncGenerator<Uint8Array> {
    for (const [name, template] of fields) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(name)) throw apiChannelFailure("parameters");
      const match = typeof template === "string" ? /^\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}$/u.exec(template) : null;
      const fileParameter = operation.parameters.find(
        (parameter) => parameter.name === match?.[1] && parameter.type === "file",
      );
      if (fileParameter) {
        const file = files.get(fileParameter.name);
        if (!file || !(await file.handle.stat()).isFile()) throw apiChannelFailure("file");
        const nameOnly = basename(file.path).replace(/[\r\n"\\]/gu, "_");
        yield encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${nameOnly}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        );
        for await (const chunk of fileChunks(file)) yield chunk;
        yield encoder.encode("\r\n");
      } else {
        const value = fill(template, values);
        if (value === null) continue;
        yield encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${printable(value)}\r\n`,
        );
      }
    }
    yield encoder.encode(`--${boundary}--\r\n`);
  }
  const iterator = parts();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > RESPONSE_LIMIT) throw apiChannelFailure("response");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function streamApiFile(
  response: Response,
  directory: string,
  signal: AbortSignal,
  fileName: string = randomUUID(),
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!fileName || /[\\/\0]/u.test(fileName) || fileName === "." || fileName === "..")
    throw apiChannelFailure("artifact");
  const path = join(directory, fileName);
  const file = await open(path, "wx", 0o600);
  let completed = false;
  try {
    if (!response.body) throw apiChannelFailure("artifact");
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        let offset = 0;
        while (offset < item.value.byteLength) {
          const written = await file.write(item.value, offset, item.value.byteLength - offset);
          if (!written.bytesWritten) throw apiChannelFailure("artifact");
          offset += written.bytesWritten;
        }
      }
      await file.sync();
      completed = true;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    await file.close();
    if (!completed) await rm(path, { force: true });
  }
  return path;
}
export function allowedApiArtifact(url: string, definition: ApiChannelDefinition): boolean {
  try {
    const parsed = new URL(url);
    const base = apiChannelUrl(definition.baseUrl);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.origin === base.origin) return true;
    if (parsed.protocol !== "https:") return false;
    return definition.artifactHosts.some((host) =>
      host.startsWith("*.")
        ? parsed.hostname.endsWith(host.slice(1)) && parsed.hostname !== host.slice(2)
        : parsed.host === host,
    );
  } catch {
    return false;
  }
}
function publicJson(
  value: ApiChannelValue,
  omitted: Set<string>,
  state: { truncated: boolean },
  full = false,
): ApiChannelValue {
  if (typeof value === "string") {
    if (omitted.has(value)) return "[artifact]";
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol) && (url.search || url.username || url.password))
        return redactText(`${url.origin}${url.pathname}?[redacted]`);
    } catch {
      /* Ordinary output text. */
    }
    const redacted = redactText(value);
    if (!full && redacted.length > 32_000) state.truncated = true;
    return full ? redacted : redacted.slice(0, 32_000);
  }
  if (Array.isArray(value)) {
    if (!full && value.length > 256) state.truncated = true;
    return (full ? value : value.slice(0, 256)).map((item) => publicJson(item, omitted, state, full));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key));
    if (!full && entries.length > 256) state.truncated = true;
    return Object.fromEntries(
      (full ? entries : entries.slice(0, 256)).map(([key, item]) => {
        if (
          [
            "input_tokens",
            "output_tokens",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "cached_tokens",
          ].includes(key) &&
          typeof item === "number"
        )
          return [key, item];
        return [
          key,
          isSecretName(key) || /(?:^|_)token$|credential|private.?key/iu.test(key)
            ? "[redacted]"
            : publicJson(item, omitted, state, full),
        ];
      }),
    );
  }
  return value;
}
function checkBusinessError(raw: ApiChannelValue, operation: ApiChannelOperation): void {
  const errorCode = operation.response.errorPath ? apiValueAt(raw, operation.response.errorPath) : undefined;
  if (errorCode !== undefined && !operation.response.okValues.includes(String(errorCode))) {
    const code = /^[-A-Za-z0-9_]{1,48}$/u.test(String(errorCode)) ? String(errorCode) : "unknown";
    throw new ApiChannelFailure({ message: sourceText("error.apiChannel.business", { code }) });
  }
}

export const requestApiOperation = Effect.fn("ApiChannels.request")(function* (
  definition: ApiChannelDefinition,
  operation: ApiChannelOperation,
  values: Values,
  credential: string | null,
  files: ReadonlyMap<string, GeneratedAttachmentSource>,
  directory: string,
  fetch: ApiChannelFetch,
) {
  return yield* Effect.tryPromise({
    try: async (interrupt) => {
      const signal = AbortSignal.any([interrupt, AbortSignal.timeout(REQUEST_TIMEOUT)]);
      const url = apiOperationUrl(definition, operation, values);
      const headers = new Headers({ Accept: "application/json" });
      for (const header of definition.headers) headers.set(header.name, printable(fill(header.value, values)));
      if (definition.auth.type !== "none") {
        if (!credential) throw apiChannelFailure("credential");
        if (definition.auth.type === "query")
          url.searchParams.set(definition.auth.name, definition.auth.prefix + credential);
        else
          headers.set(
            definition.auth.type === "bearer" ? "Authorization" : definition.auth.name,
            definition.auth.type === "bearer" ? `Bearer ${credential}` : definition.auth.prefix + credential,
          );
      }
      let body: RequestInit["body"];
      if (operation.bodyType === "json") {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(fill(parseApiJson(operation.body), await jsonFileValues(operation, values, files)));
      }
      if (operation.bodyType === "multipart") {
        const data = multipart(operation, values, files);
        headers.set("Content-Type", data.contentType);
        body = data.body;
      }
      let response = await fetch(url.href, {
        method: operation.method,
        headers,
        body,
        ...(operation.bodyType === "multipart" ? { duplex: "half" } : {}),
        signal,
        redirect: "manual",
        credentials: "omit",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiChannelFailure({
          message: sourceText("error.apiChannel.http", { status: String(response.status) }),
        });
      }
      if (operation.response.format === "binary") {
        if (operation.response.errorPath && response.headers.get("content-type")?.includes("json")) {
          const contents = await responseText(response);
          checkBusinessError(parseApiJson(contents), operation);
          response = new Response(contents, { headers: response.headers });
        }
        const id = randomUUID();
        const fileName = printable(fill(operation.response.fileName || "output.bin", values));
        const path = await streamApiFile(response, join(directory, id), signal, fileName);
        const artifact: StoredApiArtifact = {
          id,
          path,
          fileName,
          mimeType: operation.response.mimeType || response.headers.get("content-type") || "application/octet-stream",
        };
        return { raw: null, output: null, outputTruncated: false, artifacts: [artifact] };
      }
      const text = await responseText(response);
      const raw = operation.response.format === "text" ? text : parseApiJson(text);
      checkBusinessError(raw, operation);
      const artifacts: StoredApiArtifact[] = [];
      const omitted = new Set<string>();
      for (const rule of operation.response.artifacts) {
        const selected = apiValueAt(raw, rule.path);
        for (const [index, value] of (Array.isArray(selected) ? selected : [selected]).entries()) {
          if (value === null || value === undefined || value === "") continue;
          if (typeof value !== "string") throw apiChannelFailure("response");
          omitted.add(value);
          const fileName = printable(fill(rule.fileName, values));
          if (!fileName || /[\\/\0]/u.test(fileName) || fileName === "." || fileName === "..")
            throw apiChannelFailure("artifact");
          const metadata = {
            id: randomUUID(),
            fileName: index === 0 ? fileName : `${index + 1}-${fileName}`,
            mimeType: rule.mimeType,
          };
          if (rule.encoding === "url") {
            if (!allowedApiArtifact(value, definition)) throw apiChannelFailure("artifact");
            artifacts.push({ ...metadata, url: value });
          } else {
            if (
              rule.encoding === "hex" ? !/^(?:[0-9a-fA-F]{2})+$/u.test(value) : !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
            )
              throw apiChannelFailure("response");
            const bytes = Buffer.from(value, rule.encoding);
            const path = await streamApiFile(
              new Response(bytes),
              join(directory, metadata.id),
              signal,
              metadata.fileName,
            );
            artifacts.push({ ...metadata, path });
          }
          if (artifacts.length > 32) throw apiChannelFailure("response");
        }
      }
      const selected = apiValueAt(raw, operation.response.resultPath) ?? null;
      if (operation.response.format === "text" && operation.response.fileName) {
        const id = randomUUID();
        const fileName = printable(fill(operation.response.fileName, values));
        const fullText = printable(publicJson(selected, omitted, { truncated: false }, true));
        const path = await streamApiFile(new Response(fullText), join(directory, id), signal, fileName);
        artifacts.push({ id, path, fileName, mimeType: operation.response.mimeType || "text/plain" });
      }
      const display = { truncated: false };
      let output = publicJson(selected, omitted, display);
      if (JSON.stringify(output).length > 128_000) {
        display.truncated = true;
        output = { truncated: true, preview: JSON.stringify(output).slice(0, 32_000) };
      }
      if (display.truncated) {
        const id = randomUUID();
        const full = publicJson(selected, omitted, { truncated: false }, true);
        const fileName = operation.response.format === "text" ? "response.txt" : "response.json";
        const mimeType = operation.response.format === "text" ? "text/plain" : "application/json";
        const path = await streamApiFile(
          new Response(typeof full === "string" ? full : JSON.stringify(full)),
          join(directory, id),
          signal,
          fileName,
        );
        artifacts.push({ id, path, fileName, mimeType });
      }
      return { raw, output, outputTruncated: display.truncated, artifacts };
    },
    catch: (error) => (error instanceof ApiChannelFailure ? error : apiChannelFailure("request")),
  });
});
