import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  isMcpServerConfig,
  type McpKeyValue,
  type McpServerConfig,
  mcpConfigErrors,
  normalizeMcpConfig,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { z } from "zod";

/** Configuration text, not a chat attachment. Bound the JSON parser before it allocates objects. */
export const MCP_IMPORT_MAX_BYTES = 1024 * 1024;

export type McpImportIssue =
  | "mcp.import.invalidJson"
  | "mcp.import.invalidDocument"
  | "mcp.import.tooLarge"
  | "mcp.import.tooMany"
  | "mcp.import.invalidFields"
  | "mcp.import.invalidName"
  | "mcp.import.invalidCommand"
  | "mcp.import.invalidUrl"
  | "mcp.import.sseUnsupported";

export interface McpImportItem {
  index: number;
  name: string | null;
  config: McpServerConfig | null;
  issue: McpImportIssue | null;
  needsCredentials: boolean;
}

export interface McpImportResult {
  items: McpImportItem[];
  issue: McpImportIssue | null;
}

const textList = z.array(z.string());
const pairsSchema = z.union([
  z.record(z.string(), z.string()),
  z.array(z.strictObject({ key: z.string(), value: z.string() })),
]);
const transportSchema = z.enum(["stdio", "http", "streamable-http", "sse"]);

// Only these fields have a defined conversion. In particular, access rules and tool allowlists
// from another client must not disappear silently on the way into OpenBot.
const sourceSchema = z.strictObject({
  name: z.string().optional(),
  transport: transportSchema.optional(),
  type: transportSchema.optional(),
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional(),
  command: z.string().optional(),
  args: textList.optional(),
  env: pairsSchema.optional(),
  envPassthrough: textList.optional(),
  workingDirectory: z.string().optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: pairsSchema.optional(),
  auth: z.strictObject({ name: z.string(), value: z.string() }).optional(),
  authKind: z.enum(["header", "none"]).optional(),
  // Export metadata is not identity on this host. Every import remains a new, unsaved draft.
  id: z.string().optional(),
  revision: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  description: z.string().optional(),
});

type SourceConfig = z.infer<typeof sourceSchema>;

class ImportFailure extends Error {
  constructor(readonly issue: McpImportIssue) {
    super(issue);
  }
}

/** No connection, write, interpolation, or command execution happens while parsing an import. */
export function parseMcpConfigImport(text: string): McpImportResult {
  if (text.length > MCP_IMPORT_MAX_BYTES || new TextEncoder().encode(text).byteLength > MCP_IMPORT_MAX_BYTES)
    return { items: [], issue: "mcp.import.tooLarge" };
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    // JSON errors can quote the credential next to the syntax error. Never return that message.
    return { items: [], issue: "mcp.import.invalidJson" };
  }
  try {
    const entries = importEntries(document);
    if (entries.length === 0) return { items: [], issue: "mcp.import.invalidDocument" };
    if (entries.length > INPUT_LIMITS.mcpServers) return { items: [], issue: "mcp.import.tooMany" };
    return { items: entries.map(([name, value], index) => importItem(name, value, index)), issue: null };
  } catch (error) {
    return { items: [], issue: error instanceof ImportFailure ? error.issue : "mcp.import.invalidDocument" };
  }
}

function importEntries(document: unknown): Array<[string | null, unknown]> {
  if (!isDynamicRecord(document)) throw new ImportFailure("mcp.import.invalidDocument");
  if ("mcpServers" in document) {
    if (!isDynamicRecord(document.mcpServers) || "servers" in document)
      throw new ImportFailure("mcp.import.invalidDocument");
    return Object.entries(document.mcpServers);
  }
  if ("servers" in document) {
    if (!Array.isArray(document.servers)) throw new ImportFailure("mcp.import.invalidDocument");
    return document.servers.map((entry) => [null, entry]);
  }
  if ("command" in document || "url" in document) return [[null, document]];
  throw new ImportFailure("mcp.import.invalidDocument");
}

function importItem(name: string | null, value: unknown, index: number): McpImportItem {
  const label =
    (name ?? (isDynamicRecord(value) && typeof value.name === "string" ? value.name : null))?.slice(
      0,
      INPUT_LIMITS.mcpServerName,
    ) ?? null;
  try {
    const parsed = sourceSchema.safeParse(value);
    if (!parsed.success) throw new ImportFailure("mcp.import.invalidFields");
    const source = parsed.data;
    const config = convertConfig(name, source);
    const errors = mcpConfigErrors(config);
    if (errors.name) throw new ImportFailure("mcp.import.invalidName");
    if (errors.command) throw new ImportFailure("mcp.import.invalidCommand");
    if (errors.url) throw new ImportFailure("mcp.import.invalidUrl");
    if (!isMcpServerConfig(config)) throw new ImportFailure("mcp.import.invalidFields");
    return {
      index,
      name: config.name,
      config: normalizeMcpConfig(config),
      issue: null,
      needsCredentials: source.authKind === "header" && config.headers.length === 0,
    };
  } catch (error) {
    return {
      index,
      name: label,
      config: null,
      issue: error instanceof ImportFailure ? error.issue : "mcp.import.invalidFields",
      needsCredentials: false,
    };
  }
}

function convertConfig(name: string | null, source: SourceConfig): McpServerConfig {
  if (
    (name !== null && source.name !== undefined && name.trim() !== source.name.trim()) ||
    (source.enabled !== undefined && source.disabled !== undefined && source.enabled === source.disabled) ||
    (source.workingDirectory !== undefined && source.cwd !== undefined && source.workingDirectory !== source.cwd)
  )
    throw new ImportFailure("mcp.import.invalidFields");
  const declared = source.transport ?? source.type;
  const transport = declared === "streamable-http" ? "http" : declared;
  const alternate = source.type === "streamable-http" ? "http" : source.type;
  if (source.transport && alternate && transport !== alternate) throw new ImportFailure("mcp.import.invalidFields");
  if (transport === "sse") throw new ImportFailure("mcp.import.sseUnsupported");
  const headers = pairs(source.headers, true);
  if (source.auth) {
    if (headers.some((pair) => pair.key.toLowerCase() === source.auth?.name.toLowerCase()))
      throw new ImportFailure("mcp.import.invalidFields");
    headers.push({ key: source.auth.name, value: source.auth.value });
  }
  const config: McpServerConfig = {
    id: "",
    name: (name ?? source.name ?? "").trim(),
    transport: transport ?? (source.url ? "http" : "stdio"),
    enabled: source.enabled ?? !source.disabled,
    command: source.command ?? "",
    args: source.args ?? [],
    env: pairs(source.env),
    envPassthrough: source.envPassthrough ?? [],
    workingDirectory: source.workingDirectory ?? source.cwd ?? "",
    url: source.url ?? "",
    headers,
  };
  if (
    [config.command, config.workingDirectory, ...config.args].some((value) => value.includes("\0")) ||
    config.args.some((argument) => argument.trim().length === 0) ||
    config.env.some((pair) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(pair.key) || pair.value.includes("\0")) ||
    config.envPassthrough.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) ||
    config.headers.some((pair) => !/^[!#$%&'*+.^_`|~\w-]+$/u.test(pair.key) || /[\r\n\0]/u.test(pair.value))
  )
    throw new ImportFailure("mcp.import.invalidFields");
  if (config.transport === "stdio") {
    if (config.url || config.headers.length || source.authKind === "header")
      throw new ImportFailure("mcp.import.invalidFields");
  } else {
    if (
      config.command ||
      config.args.length ||
      config.env.length ||
      config.envPassthrough.length ||
      config.workingDirectory
    )
      throw new ImportFailure("mcp.import.invalidFields");
    const url = URL.parse(config.url);
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new ImportFailure("mcp.import.invalidUrl");
  }
  return config;
}

function pairs(value: z.infer<typeof pairsSchema> | undefined, caseInsensitive = false): McpKeyValue[] {
  const entries =
    value === undefined
      ? []
      : Array.isArray(value)
        ? value
        : Object.entries(value).map(([key, value]) => ({ key, value }));
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = caseInsensitive ? entry.key.toLowerCase() : entry.key;
    if (!key.trim() || keys.has(key)) throw new ImportFailure("mcp.import.invalidFields");
    keys.add(key);
  }
  return entries;
}

/** The preview shows only the destination host or executable name, never arguments or URL secrets. */
export function mcpImportDestination(config: McpServerConfig): string {
  if (config.transport === "http") return URL.parse(config.url)?.host ?? "";
  return config.command.trim().split(/[\\/]/u).at(-1) ?? "";
}
