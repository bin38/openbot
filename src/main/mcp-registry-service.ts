import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isMcpRegistryPage,
  type McpRegistryConnection,
  type McpRegistryField,
  type McpRegistryPage,
  type McpRegistryQuery,
  type McpRegistryServer,
} from "@openbot/contracts/ipc-mcp-registry";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";
const RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const NPM_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u;
const PINNED_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;

export class McpRegistryFailure extends Schema.TaggedError<McpRegistryFailure>()("McpRegistryFailure", {
  message: Schema.String,
}) {}
export type McpRegistryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function short(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").slice(0, maximum) : "";
}

function https(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[{}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some((key) => /(?:api.?key|token|secret|password|authorization)/iu.test(key)))
      return null;
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}

function fields(value: unknown, target: McpRegistryField["target"]): McpRegistryField[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: McpRegistryField[] = [];
  for (const item of value) {
    if (!isDynamicRecord(item) || typeof item.name !== "string") return null;
    const name = item.name;
    if (target === "env" ? !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) : !/^[A-Za-z][A-Za-z0-9-]{0,127}$/u.test(name))
      return null;
    if (result.some((field) => field.name.toLowerCase() === name.toLowerCase())) return null;
    result.push({
      name,
      target,
      label: short(item.title, 256) || name,
      description: short(item.description, 2048),
      required: item.isRequired === true,
      secret: item.isSecret === true || /key|token|secret|password|authorization|cookie/iu.test(name),
    });
  }
  // Registry defaults can contain someone else's credential. Never copy their values into a configuration.
  return result;
}

function fixedArguments(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: string[] = [];
  for (const item of value) {
    if (
      !isDynamicRecord(item) ||
      item.isSecret === true ||
      item.variables !== undefined ||
      /key|token|secret|password|authorization/iu.test(short(item.name, 128))
    )
      return null;
    const argument = typeof item.value === "string" ? item.value : null;
    if (argument === null || argument.length > 4096 || /[{}\p{Cc}]/u.test(argument)) return null;
    if (item.type === "named") {
      if (typeof item.name !== "string" || !/^--?[A-Za-z][A-Za-z0-9-]*$/u.test(item.name)) return null;
      result.push(item.name);
    } else if (item.type !== "positional") return null;
    result.push(argument);
  }
  return result;
}

function connections(server: DynamicRecord): McpRegistryConnection[] {
  const result: McpRegistryConnection[] = [];
  for (const [index, remote] of (Array.isArray(server.remotes) ? server.remotes.slice(0, 8) : []).entries()) {
    if (!isDynamicRecord(remote) || remote.type !== "streamable-http") continue;
    const url = https(remote.url);
    const headers = fields(remote.headers, "header");
    if (url && headers)
      result.push({ id: `http-${index}`, transport: "http", url, command: "", args: [], fields: headers });
  }
  for (const [index, item] of (Array.isArray(server.packages) ? server.packages.slice(0, 8) : []).entries()) {
    if (
      !isDynamicRecord(item) ||
      item.registryType !== "npm" ||
      !isDynamicRecord(item.transport) ||
      item.transport.type !== "stdio"
    )
      continue;
    if (
      typeof item.identifier !== "string" ||
      !NPM_NAME.test(item.identifier) ||
      typeof item.version !== "string" ||
      !PINNED_VERSION.test(item.version)
    )
      continue;
    // Only the ordinary confirmation flag is recognized. Other runtime flags need manual review.
    if (
      item.runtimeArguments !== undefined &&
      (!Array.isArray(item.runtimeArguments) ||
        !item.runtimeArguments.every(
          (argument) =>
            isDynamicRecord(argument) &&
            argument.type === "positional" &&
            (argument.value === "-y" || argument.value === "--yes"),
        ))
    )
      continue;
    const args = fixedArguments(item.packageArguments);
    const env = fields(item.environmentVariables, "env");
    if (args && env)
      result.push({
        id: `npm-${index}`,
        transport: "stdio",
        url: "",
        command: "npx",
        args: ["-y", `${item.identifier}@${item.version}`, ...args],
        fields: env,
      });
  }
  return result.slice(0, 8);
}

/** Parse public publisher metadata into bounded, non-executing connection descriptions. */
export function parseMcpRegistryResponse(value: unknown, fetchedAt: string): McpRegistryPage {
  if (!isDynamicRecord(value) || !Array.isArray(value.servers) || value.servers.length > 50)
    throw new Error("Invalid registry response.");
  const servers: McpRegistryServer[] = [];
  for (const envelope of value.servers) {
    if (!isDynamicRecord(envelope) || !isDynamicRecord(envelope.server)) continue;
    const server = envelope.server;
    const name = short(server.name, 256);
    const version = short(server.version, 128);
    if (!name || !version) continue;
    servers.push({
      name,
      title: short(server.title, 256) || name,
      description: short(server.description, 4096),
      version,
      websiteUrl:
        https(server.websiteUrl) ?? (isDynamicRecord(server.repository) ? https(server.repository.url) : null),
      connections: connections(server),
    });
  }
  const metadata = isDynamicRecord(value.metadata) ? value.metadata : null;
  const nextCursor =
    metadata && typeof metadata.nextCursor === "string" && metadata.nextCursor.length <= 4096
      ? metadata.nextCursor
      : null;
  return { servers, nextCursor, fetchedAt, stale: false };
}

export class McpRegistryService {
  constructor(
    private readonly cacheDirectory: string,
    private readonly request: McpRegistryFetch = (input, init) => fetch(input, init),
  ) {}

  readonly search = Effect.fn("McpRegistry.search")(function* (this: McpRegistryService, input: McpRegistryQuery) {
    const url = new URL(REGISTRY);
    url.searchParams.set("version", "latest");
    url.searchParams.set("limit", "30");
    if (input.query?.trim()) url.searchParams.set("search", input.query.trim());
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    const path = join(this.cacheDirectory, `${createHash("sha256").update(url.href).digest("hex")}.json`);
    const cached = yield* Effect.promise(() => this.readCache(path));
    if (!input.refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_AGE_MS) return cached;
    const fetched = yield* Effect.result(
      Effect.tryPromise({
        try: async (signal) => {
          const response = await this.request(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            redirect: "error",
            headers: { Accept: "application/json" },
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error("Registry request failed.");
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > RESPONSE_BYTES) throw new Error("Registry response is too large.");
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          return parseMcpRegistryResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")), new Date().toISOString());
        },
        catch: () => new McpRegistryFailure({ message: sourceText("error.mcp.registryUnavailable") }),
      }),
    );
    if (Result.isFailure(fetched)) {
      if (cached) return { ...cached, stale: true };
      return yield* Effect.fail(fetched.failure);
    }
    // A full disk must not turn a successful public catalog read into a failed search.
    yield* writeJsonFileAtomically(path, { version: 1, page: fetched.success }, { createDirectory: true }).pipe(
      Effect.ignore,
    );
    return fetched.success;
  });

  private async readCache(path: string): Promise<McpRegistryPage | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > RESPONSE_BYTES) return null;
      const text = await readFile(path, "utf8");
      if (text.length > RESPONSE_BYTES) return null;
      const value = JSON.parse(text);
      return isDynamicRecord(value) && value.version === 1 && isMcpRegistryPage(value.page) ? value.page : null;
    } catch {
      return null;
    }
  }
}
