import type { ApiChannelDefinition, ApiChannelValue } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";

const text = Schema.String.check(Schema.isMaxLength(64_000));
const short = Schema.String.check(Schema.isMaxLength(512));
const list = <S extends Schema.Constraint>(schema: S, maximum = 64) =>
  Schema.mutable(Schema.Array(schema).check(Schema.isMaxLength(maximum)));
const pair = Schema.Struct({ name: short, value: text });
const parameter = Schema.Struct({
  name: short,
  type: Schema.Literals(["string", "number", "boolean", "json", "file"]),
  required: Schema.Boolean,
  description: text,
  defaultJson: text,
  fileEncoding: Schema.optionalKey(Schema.Literals(["data-url", "base64"])),
});
const artifact = Schema.Struct({
  path: short,
  encoding: Schema.Literals(["url", "hex", "base64"]),
  fileName: short,
  mimeType: short,
});
const response = Schema.Struct({
  format: Schema.Literals(["json", "text", "binary"]),
  resultPath: short,
  errorPath: short,
  okValues: list(short),
  fileName: short,
  mimeType: short,
  artifacts: list(artifact, 16),
  statusPath: short,
  successValues: list(short),
  failureValues: list(short),
});
const operation = Schema.Struct({
  id: short,
  name: short,
  description: text,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: text,
  bodyType: Schema.Literals(["none", "json", "multipart"]),
  body: text,
  query: list(pair),
  parameters: list(parameter),
  readOnly: Schema.Boolean,
  response,
  job: Schema.NullOr(Schema.Struct({ idPath: short, pollOperationId: short, pollParameter: short })),
});
export const ApiChannelDefinitionSchema = Schema.Struct({
  name: short,
  description: text,
  baseUrl: text,
  auth: Schema.Struct({ type: Schema.Literals(["none", "bearer", "header", "query"]), name: short, prefix: short }),
  headers: list(pair, 32),
  artifactHosts: list(short, 32),
  operations: list(operation, 96),
});

export class ApiChannelFailure extends Schema.TaggedError<ApiChannelFailure>()("ApiChannelFailure", {
  message: Schema.String,
  kind: Schema.optionalKey(Schema.String),
}) {}
export function apiChannelFailure(
  key:
    | "invalid"
    | "storage"
    | "credential"
    | "origin"
    | "unavailable"
    | "parameters"
    | "file"
    | "request"
    | "response"
    | "run"
    | "artifact"
    | "pending"
    | "failed",
): ApiChannelFailure {
  const keys = {
    invalid: "error.apiChannel.invalid",
    storage: "error.apiChannel.storage",
    credential: "error.apiChannel.credential",
    origin: "error.apiChannel.origin",
    unavailable: "error.apiChannel.unavailable",
    parameters: "error.apiChannel.parameters",
    file: "error.apiChannel.file",
    request: "error.apiChannel.request",
    response: "error.apiChannel.response",
    run: "error.apiChannel.run",
    artifact: "error.apiChannel.artifact",
    pending: "error.apiChannel.pending",
    failed: "error.apiChannel.failed",
  } as const;
  return new ApiChannelFailure({ message: sourceText(keys[key]), kind: key });
}
export function apiChannelUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw apiChannelFailure("invalid");
  return url;
}
export function parseApiJson(text: string): ApiChannelValue {
  const value = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    // Preserve integer IDs that JSON.parse would otherwise round before a follow-up request.
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source)
      return context.source;
    return value;
  });
  return Schema.decodeUnknownSync(Schema.MutableJson)(value);
}
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/u;
export function parseApiChannelDefinition(input: string): ApiChannelDefinition {
  try {
    if (input.length > 512_000 || /\b(?:sk-[A-Za-z0-9_-]{16,}|e2b_[a-f0-9]{32,})\b/iu.test(input))
      throw apiChannelFailure("invalid");
    const definition = Schema.decodeUnknownSync(ApiChannelDefinitionSchema, { onExcessProperty: "error" })(
      JSON.parse(input),
    );
    if (!definition.name.trim() || !definition.operations.length) throw apiChannelFailure("invalid");
    apiChannelUrl(definition.baseUrl);
    if (
      /[\r\n]/u.test(definition.auth.prefix) ||
      (definition.auth.type === "header" && !/^[A-Za-z][A-Za-z0-9-]{0,95}$/u.test(definition.auth.name)) ||
      (definition.auth.type === "query" && !namePattern.test(definition.auth.name))
    )
      throw apiChannelFailure("invalid");
    for (const header of definition.headers) {
      if (
        !/^[A-Za-z][A-Za-z0-9-]{0,95}$/u.test(header.name) ||
        /authorization|cookie|token|secret|password|api.?key|^host$|^content-length$|^transfer-encoding$/iu.test(
          header.name,
        ) ||
        /[\r\n]/u.test(header.value)
      )
        throw apiChannelFailure("invalid");
    }
    const ids = new Set<string>();
    for (const op of definition.operations) {
      if (
        !namePattern.test(op.id) ||
        ids.has(op.id) ||
        !op.path.startsWith("/") ||
        op.path.startsWith("//") ||
        /[?#\\]|(?:^|\/)\.{1,2}(?:\/|$)/u.test(op.path)
      )
        throw apiChannelFailure("invalid");
      ids.add(op.id);
      const names = new Set<string>();
      for (const parameter of op.parameters) {
        if (!namePattern.test(parameter.name) || names.has(parameter.name)) throw apiChannelFailure("invalid");
        names.add(parameter.name);
        if (parameter.defaultJson) parseApiJson(parameter.defaultJson);
      }
      if (op.bodyType !== "none") parseApiJson(op.body);
      for (const pair of op.query)
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(pair.name)) throw apiChannelFailure("invalid");
      for (const artifact of op.response.artifacts)
        if (/[\\/\0]/u.test(artifact.fileName) || !artifact.fileName) throw apiChannelFailure("invalid");
      if (/[\\/\0]/u.test(op.response.fileName)) throw apiChannelFailure("invalid");
    }
    for (const op of definition.operations)
      if (op.job) {
        const poll = definition.operations.find((item) => item.id === op.job?.pollOperationId);
        const parameter = poll?.parameters.find((item) => item.name === op.job?.pollParameter);
        if (!poll?.readOnly || !parameter || !["string", "number", "json"].includes(parameter.type))
          throw apiChannelFailure("invalid");
      }
    for (const host of definition.artifactHosts)
      if (!/^(?:\*\.)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/u.test(host) || host === "*")
        throw apiChannelFailure("invalid");
    return definition;
  } catch {
    throw apiChannelFailure("invalid");
  }
}

export function apiValueAt(value: ApiChannelValue, path: string): ApiChannelValue | undefined {
  let current: ApiChannelValue | undefined = value;
  if (!path) return current;
  for (const part of path.split(".")) {
    if (["__proto__", "constructor", "prototype"].includes(part)) return undefined;
    if (Array.isArray(current)) current = /^\d+$/u.test(part) ? current[Number(part)] : undefined;
    else if (current !== null && typeof current === "object" && Object.hasOwn(current, part)) current = current[part];
    else return undefined;
  }
  return current;
}
