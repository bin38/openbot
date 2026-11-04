import { type DynamicRecord, isDynamicRecord, isOneOf } from "./runtime-values";

/** JSON-only request templates. No executable source or credentials are part of a definition. */
export type ApiChannelValue = null | boolean | number | string | ApiChannelValue[] | { [key: string]: ApiChannelValue };
export interface ApiChannelPair {
  name: string;
  value: string;
}
export interface ApiChannelParameter {
  name: string;
  type: "string" | "number" | "boolean" | "json" | "file";
  required: boolean;
  description: string;
  /** A JSON literal, or an empty string for no default. */
  defaultJson: string;
  /** JSON bodies embed scoped file bytes; multipart sends the open file stream. */
  fileEncoding?: "data-url" | "base64";
}
export interface ApiChannelArtifactRule {
  path: string;
  encoding: "url" | "hex" | "base64";
  fileName: string;
  mimeType: string;
}
export interface ApiChannelOperation {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  bodyType: "none" | "json" | "multipart";
  /** JSON template; a whole {{parameter}} value retains that parameter's JSON type. */
  body: string;
  query: ApiChannelPair[];
  parameters: ApiChannelParameter[];
  readOnly: boolean;
  response: {
    format: "json" | "text" | "binary";
    resultPath: string;
    errorPath: string;
    okValues: string[];
    fileName: string;
    mimeType: string;
    artifacts: ApiChannelArtifactRule[];
    statusPath: string;
    successValues: string[];
    failureValues: string[];
  };
  /** Jobs use an opaque local ID bound to the calling agent and saved operation revision. */
  job: { idPath: string; pollOperationId: string; pollParameter: string } | null;
}
export interface ApiChannelDefinition {
  name: string;
  description: string;
  baseUrl: string;
  auth: { type: "none" | "bearer" | "header" | "query"; name: string; prefix: string };
  headers: ApiChannelPair[];
  /** Exact hosts or *.suffix entries; artifact requests never receive channel credentials. */
  artifactHosts: string[];
  operations: ApiChannelOperation[];
}
export interface ApiChannelSummary {
  id: string;
  definition: ApiChannelDefinition;
  enabled: boolean;
  source: "user" | "agent";
  credentialStatus: "saved" | "missing" | "unreadable" | "not-required";
  updatedAt: string;
}
export interface ApiChannelTemplate {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
  definition: ApiChannelDefinition;
}
export interface SaveApiChannelInput {
  /** Omit to add. Existing IDs update only that channel. */
  id?: string;
  definitionJson: string;
  enabled: boolean;
  /** Omit or leave empty to keep an existing credential on the same origin. */
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface ApiChannelIdInput {
  id: string;
}
export interface ApiChannelListRunsInput {
  /** Omit to include records whose channel configuration has since been removed. */
  channelId?: string;
}
export interface SetApiChannelEnabledInput extends ApiChannelIdInput {
  enabled: boolean;
}
export interface ValidateApiChannelInput {
  definitionJson: string;
}
export interface InvokeApiChannelInput {
  channelId: string;
  operationId: string;
  valuesJson: string;
}
export interface ApiChannelArtifact {
  id: string;
  fileName: string;
  mimeType: string;
}
export interface ApiChannelRun {
  id: string;
  channelId: string;
  operationId: string;
  status: "completed" | "pending" | "failed" | "unknown";
  output: ApiChannelValue;
  outputTruncated?: boolean;
  artifacts: ApiChannelArtifact[];
  message: string | null;
}

/** Local-owner history metadata. No response content, credential, URL, or cache path is exposed. */
export interface ApiChannelRunSummary {
  id: string;
  channelId: string;
  channelName: string | null;
  operationId: string;
  operationName: string;
  status: ApiChannelRun["status"];
  createdAt: string | null;
  updatedAt: string | null;
  artifactCount: number;
}

/** Bounds for public IPC replies. The main request adapter separately validates executable behavior. */
export const API_CHANNEL_PUBLIC_LIMITS = {
  channels: 128,
  templates: 64,
  runs: 50,
  definitionCharacters: 512_000,
  operationCount: 96,
  parameterCount: 64,
  shortText: 512,
  longText: 64_000,
  outputText: 32_000,
  outputCharacters: 32 * 1024 * 1024,
  outputNodes: 131_072,
  outputDepth: 64,
} as const;

interface CharacterBudget {
  remaining: number;
}
function publicText(value: unknown, maximum: number, budget?: CharacterBudget): value is string {
  if (typeof value !== "string" || value.length > maximum) return false;
  if (budget) {
    budget.remaining -= value.length;
    if (budget.remaining < 0) return false;
  }
  return true;
}
function exactRecord(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): value is DynamicRecord {
  return (
    isDynamicRecord(value) &&
    fields.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => fields.includes(key) || optional.includes(key))
  );
}
function publicList<T>(value: unknown, maximum: number, item: (value: unknown) => value is T): value is T[] {
  return Array.isArray(value) && value.length <= maximum && value.every(item);
}
function publicId(value: unknown): value is string {
  return publicText(value, 128) && value.length > 0 && !/[\p{Cc}]/u.test(value);
}
function publicAddress(value: unknown, docs = false): value is string {
  if (!publicText(value, API_CHANNEL_PUBLIC_LIMITS.longText)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (!docs && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
function publicPair(value: unknown, budget: CharacterBudget): value is ApiChannelPair {
  return (
    exactRecord(value, ["name", "value"]) &&
    publicText(value.name, 512, budget) &&
    publicText(value.value, 64_000, budget)
  );
}
function publicParameter(value: unknown, budget: CharacterBudget): value is ApiChannelParameter {
  return (
    exactRecord(value, ["name", "type", "required", "description", "defaultJson"], ["fileEncoding"]) &&
    publicText(value.name, 512, budget) &&
    isOneOf(["string", "number", "boolean", "json", "file"] as const, value.type) &&
    typeof value.required === "boolean" &&
    publicText(value.description, 64_000, budget) &&
    publicText(value.defaultJson, 64_000, budget) &&
    (value.fileEncoding === undefined || isOneOf(["data-url", "base64"] as const, value.fileEncoding))
  );
}
function artifactRule(value: unknown, budget: CharacterBudget): value is ApiChannelArtifactRule {
  return (
    exactRecord(value, ["path", "encoding", "fileName", "mimeType"]) &&
    publicText(value.path, 512, budget) &&
    isOneOf(["url", "hex", "base64"] as const, value.encoding) &&
    publicText(value.fileName, 512, budget) &&
    value.fileName.length > 0 &&
    !/[/\\\0]/u.test(value.fileName) &&
    publicText(value.mimeType, 512, budget)
  );
}
function publicResponse(value: unknown, budget: CharacterBudget): value is ApiChannelOperation["response"] {
  const strings = (value: unknown): value is string[] =>
    publicList(value, 64, (item): item is string => publicText(item, 512, budget));
  return (
    exactRecord(value, [
      "format",
      "resultPath",
      "errorPath",
      "okValues",
      "fileName",
      "mimeType",
      "artifacts",
      "statusPath",
      "successValues",
      "failureValues",
    ]) &&
    isOneOf(["json", "text", "binary"] as const, value.format) &&
    publicText(value.resultPath, 512, budget) &&
    publicText(value.errorPath, 512, budget) &&
    strings(value.okValues) &&
    publicText(value.fileName, 512, budget) &&
    !/[/\\\0]/u.test(value.fileName) &&
    publicText(value.mimeType, 512, budget) &&
    publicList(value.artifacts, 16, (item): item is ApiChannelArtifactRule => artifactRule(item, budget)) &&
    publicText(value.statusPath, 512, budget) &&
    strings(value.successValues) &&
    strings(value.failureValues)
  );
}
function publicJob(value: unknown, budget: CharacterBudget): value is ApiChannelOperation["job"] {
  return (
    value === null ||
    (exactRecord(value, ["idPath", "pollOperationId", "pollParameter"]) &&
      publicText(value.idPath, 512, budget) &&
      publicText(value.pollOperationId, 512, budget) &&
      publicText(value.pollParameter, 512, budget))
  );
}
function publicOperation(value: unknown, budget: CharacterBudget): value is ApiChannelOperation {
  return (
    exactRecord(value, [
      "id",
      "name",
      "description",
      "method",
      "path",
      "bodyType",
      "body",
      "query",
      "parameters",
      "readOnly",
      "response",
      "job",
    ]) &&
    publicText(value.id, 512, budget) &&
    publicText(value.name, 512, budget) &&
    publicText(value.description, 64_000, budget) &&
    isOneOf(["GET", "POST", "PUT", "PATCH", "DELETE"] as const, value.method) &&
    publicText(value.path, 64_000, budget) &&
    value.path.startsWith("/") &&
    !value.path.startsWith("//") &&
    !/[?#\\]/u.test(value.path) &&
    isOneOf(["none", "json", "multipart"] as const, value.bodyType) &&
    publicText(value.body, 64_000, budget) &&
    publicList(value.query, 64, (item): item is ApiChannelPair => publicPair(item, budget)) &&
    publicList(value.parameters, 64, (item): item is ApiChannelParameter => publicParameter(item, budget)) &&
    typeof value.readOnly === "boolean" &&
    publicResponse(value.response, budget) &&
    publicJob(value.job, budget)
  );
}

/** Exact public fields reject accidental API keys, encrypted keys, headers, or paths added by main. */
export function isApiChannelDefinition(value: unknown): value is ApiChannelDefinition {
  const budget = { remaining: API_CHANNEL_PUBLIC_LIMITS.definitionCharacters };
  return (
    exactRecord(value, ["name", "description", "baseUrl", "auth", "headers", "artifactHosts", "operations"]) &&
    publicText(value.name, 512, budget) &&
    value.name.trim().length > 0 &&
    publicText(value.description, 64_000, budget) &&
    publicText(value.baseUrl, 64_000, budget) &&
    publicAddress(value.baseUrl) &&
    exactRecord(value.auth, ["type", "name", "prefix"]) &&
    isOneOf(["none", "bearer", "header", "query"] as const, value.auth.type) &&
    publicText(value.auth.name, 512, budget) &&
    publicText(value.auth.prefix, 512, budget) &&
    !/[\r\n]/u.test(value.auth.prefix) &&
    publicList(
      value.headers,
      32,
      (item): item is ApiChannelPair =>
        publicPair(item, budget) &&
        !/authorization|cookie|token|secret|password|api.?key|^host$|^content-length$|^transfer-encoding$/iu.test(
          item.name,
        ),
    ) &&
    publicList(value.artifactHosts, 32, (item): item is string => publicText(item, 512, budget)) &&
    publicList(value.operations, API_CHANNEL_PUBLIC_LIMITS.operationCount, (item): item is ApiChannelOperation =>
      publicOperation(item, budget),
    ) &&
    value.operations.length > 0
  );
}
export function isApiChannelSummary(value: unknown): value is ApiChannelSummary {
  return (
    exactRecord(value, ["id", "definition", "enabled", "source", "credentialStatus", "updatedAt"]) &&
    publicId(value.id) &&
    isApiChannelDefinition(value.definition) &&
    typeof value.enabled === "boolean" &&
    isOneOf(["user", "agent"] as const, value.source) &&
    isOneOf(["saved", "missing", "unreadable", "not-required"] as const, value.credentialStatus) &&
    publicText(value.updatedAt, 64) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}
export function isApiChannelTemplate(value: unknown): value is ApiChannelTemplate {
  return (
    exactRecord(value, ["id", "name", "description", "docsUrl", "definition"]) &&
    publicId(value.id) &&
    publicText(value.name, 512) &&
    publicText(value.description, 64_000) &&
    (value.docsUrl === "" || publicAddress(value.docsUrl, true)) &&
    isApiChannelDefinition(value.definition)
  );
}

const PRIVATE_OUTPUT_FIELD =
  /^(?:api_?key|sealed_?key|[a-z_-]*token|authorization|password|secret|credential|private_?key)$/iu;
/** A bounded JSON tree. A faulty adapter cannot pass an unredacted credential or a cyclic value. */
export function isApiChannelValue(value: unknown): value is ApiChannelValue {
  let nodes: number = API_CHANNEL_PUBLIC_LIMITS.outputNodes;
  let characters: number = API_CHANNEL_PUBLIC_LIMITS.outputCharacters;
  const active = new Set<object>();
  const inspect = (value: unknown, depth: number): boolean => {
    nodes -= 1;
    if (nodes < 0 || depth > API_CHANNEL_PUBLIC_LIMITS.outputDepth) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
      characters -= value.length;
      return value.length <= API_CHANNEL_PUBLIC_LIMITS.outputText && characters >= 0;
    }
    if (typeof value !== "object" || active.has(value)) return false;
    active.add(value);
    let valid = false;
    if (Array.isArray(value)) valid = value.length <= 256 && value.every((item) => inspect(item, depth + 1));
    else if (isDynamicRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const entries = Object.entries(value);
      valid =
        entries.length <= 256 &&
        entries.every(([key, item]) => {
          characters -= key.length;
          if (characters < 0 || key.length > 512 || ["__proto__", "constructor", "prototype"].includes(key))
            return false;
          if (PRIVATE_OUTPUT_FIELD.test(key) && item !== "[redacted]") return false;
          return inspect(item, depth + 1);
        });
    }
    active.delete(value);
    return valid;
  };
  return inspect(value, 0);
}
function publicArtifact(value: unknown): value is ApiChannelArtifact {
  return (
    exactRecord(value, ["id", "fileName", "mimeType"]) &&
    publicId(value.id) &&
    publicText(value.fileName, 512) &&
    value.fileName.length > 0 &&
    !/[/\\\0]/u.test(value.fileName) &&
    publicText(value.mimeType, 512)
  );
}
export function isApiChannelRun(value: unknown): value is ApiChannelRun {
  return (
    exactRecord(
      value,
      ["id", "channelId", "operationId", "status", "output", "artifacts", "message"],
      ["outputTruncated"],
    ) &&
    publicId(value.id) &&
    publicId(value.channelId) &&
    publicId(value.operationId) &&
    isOneOf(["completed", "pending", "failed", "unknown"] as const, value.status) &&
    isApiChannelValue(value.output) &&
    publicList(value.artifacts, 64, publicArtifact) &&
    (value.message === null || publicText(value.message, 32_000)) &&
    (value.outputTruncated === undefined || typeof value.outputTruncated === "boolean")
  );
}

export function isApiChannelRunSummary(value: unknown): value is ApiChannelRunSummary {
  const date = (input: unknown) => input === null || (publicText(input, 64) && Number.isFinite(Date.parse(input)));
  return (
    exactRecord(value, [
      "id",
      "channelId",
      "channelName",
      "operationId",
      "operationName",
      "status",
      "createdAt",
      "updatedAt",
      "artifactCount",
    ]) &&
    publicId(value.id) &&
    publicId(value.channelId) &&
    (value.channelName === null || publicText(value.channelName, 512)) &&
    publicId(value.operationId) &&
    publicText(value.operationName, 512) &&
    isOneOf(["completed", "pending", "failed", "unknown"] as const, value.status) &&
    date(value.createdAt) &&
    date(value.updatedAt) &&
    typeof value.artifactCount === "number" &&
    Number.isSafeInteger(value.artifactCount) &&
    value.artifactCount >= 0 &&
    value.artifactCount <= 64
  );
}
