import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  ApiChannelRun,
  ApiChannelSummary,
  ApiChannelTemplate,
  InvokeApiChannelInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import type { GeneratedAttachmentSource } from "../attachment-files";
import { type DynamicToolResult, isRecord } from "../protocol";
import type { AttachmentGateway } from "./attachment-gateway";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

/** Main owns credentials, HTTP destinations, durable runs, and generated artifacts. */
export interface ApiChannelTools {
  list(): ApiChannelSummary[];
  templates?(): ApiChannelTemplate[];
  createDraft(agentId: string, definitionJson: string): Effect.Effect<ApiChannelSummary, { message: string }>;
  call(
    agentId: string,
    input: InvokeApiChannelInput,
    files: ReadonlyMap<string, GeneratedAttachmentSource>,
    requestId: string,
  ): Effect.Effect<ApiChannelRun, { message: string }>;
  poll(agentId: string, runId: string): Effect.Effect<ApiChannelRun, { message: string }>;
  download<A, E>(
    agentId: string,
    artifactId: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | { message: string }>;
}

const identifier = z.string().trim().min(1).max(INPUT_LIMITS.identifier);
const jsonText = z.string().min(2).max(1_048_576);
const listSchema = z.strictObject({ templateId: identifier.optional() });
const draftSchema = z.strictObject({
  definitionJson: jsonText.describe(
    "JSON definition from a list_api_channels template. No keys, tokens, passwords, cookies or secret headers.",
  ),
});
const callSchema = z.strictObject({
  channelId: identifier,
  operationId: identifier,
  valuesJson: jsonText.describe(
    "JSON object of advertised parameters only. Files must be regular files in your workspace, Shared or approved folders. No extra target URL or credentials.",
  ),
});
const runSchema = z.strictObject({ runId: identifier });
const downloadSchema = z.strictObject({ artifactId: identifier });

export const API_CHANNEL_TOOL_DEFINITIONS = [
  {
    name: "list_api_channels",
    description:
      "List HTTP API channels, operations (ASR, OCR, speech, image, video, search, custom), parameters and credential readiness, never credentials. Includes template summaries; templateId returns a full draft definition.",
    shape: listSchema.shape,
  },
  {
    name: "create_api_channel_draft",
    description:
      "On a user request, create a disabled channel from a list_api_channels template. The user reviews it, enters credentials and enables it in Server settings, API endpoints. Cannot change existing channels, borrow keys, enable or execute.",
    shape: draftSchema.shape,
  },
  {
    name: "call_api_channel",
    description:
      "Call an enabled channel operation: MiniMax ASR, speech, visual text extraction, image/video or custom API. List channels first; use advertised IDs/parameters only. Inputs/files go to the service and may use quota. Mutations/deletes require a user request. Poll/download via returned local IDs, never by repeating generation.",
    shape: callSchema.shape,
  },
  {
    name: "get_api_channel_run",
    description:
      "Read/poll this agent's local runId using its saved polling operation, never a supplied URL or vendor task ID. Pending status does not authorize repeating generation.",
    shape: runSchema.shape,
  },
  {
    name: "download_api_channel_artifact",
    description:
      "Deliver this agent's generated artifact to the current chat as a managed download. Use its local artifactId, never a URL, vendor file ID or output path. Does not regenerate.",
    shape: downloadSchema.shape,
  },
];

export type ApiChannelToolRequest =
  | { tool: "list_api_channels"; templateId?: string | undefined }
  | { tool: "create_api_channel_draft"; definitionJson: string }
  | ({ tool: "call_api_channel" } & InvokeApiChannelInput)
  | { tool: "get_api_channel_run"; runId: string }
  | { tool: "download_api_channel_artifact"; artifactId: string };

export function isApiChannelTool(tool: string): boolean {
  return API_CHANNEL_TOOL_DEFINITIONS.some((definition) => definition.name === tool);
}

/** Parse once before approval. The model cannot select the calling agent or supply an API key. */
export function parseApiChannelToolRequest(tool: string, args: unknown): ApiChannelToolRequest | null {
  switch (tool) {
    case "list_api_channels": {
      const parsed = listSchema.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "create_api_channel_draft": {
      const parsed = draftSchema.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "call_api_channel": {
      const parsed = callSchema.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "get_api_channel_run": {
      const parsed = runSchema.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "download_api_channel_artifact": {
      const parsed = downloadSchema.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    default:
      return null;
  }
}

const invalid = () => ({ message: sourceText("error.apiChannel.parameters") });

/** The file handles remain owned by the caller until the HTTP operation settles or is cancelled. */
export const callApiChannelWithFiles = Effect.fn("ApiChannelTools.callWithFiles")(function* (
  agentId: string,
  input: InvokeApiChannelInput,
  tools: ApiChannelTools,
  attachments: Pick<AttachmentGateway, "openSources">,
  requestId: string,
) {
  const operation = tools
    .list()
    .find((channel) => channel.id === input.channelId)
    ?.definition.operations.find((candidate) => candidate.id === input.operationId);
  if (!operation) return yield* Effect.fail({ message: sourceText("error.apiChannel.unavailable") });
  const values = yield* Effect.try({ try: (): unknown => JSON.parse(input.valuesJson), catch: invalid });
  if (!isRecord(values)) return yield* Effect.fail(invalid());
  const inputs: { name: string; path: string }[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.type !== "file") continue;
    const supplied = Object.hasOwn(values, parameter.name);
    const value = supplied
      ? values[parameter.name]
      : parameter.defaultJson
        ? yield* Effect.try({ try: (): unknown => JSON.parse(parameter.defaultJson), catch: invalid })
        : undefined;
    if (value === undefined && !parameter.required) continue;
    if (typeof value !== "string" || !value || value.length > INPUT_LIMITS.path || value.includes("\0"))
      return yield* Effect.fail(invalid());
    inputs.push({ name: parameter.name, path: value });
  }
  // One configured file parameter can appear more than once in a multipart body. Do not open a
  // duplicate handle for an identical input path; every returned handle is still closed once.
  const paths = [...new Set(inputs.map((input) => input.path))];
  return yield* Effect.acquireUseRelease(
    attachments
      .openSources(agentId, paths, { allowAnyReadablePath: false })
      .pipe(Effect.mapError(() => ({ message: sourceText("error.apiChannel.file") }))),
    (sources) => {
      const files = new Map<string, GeneratedAttachmentSource>();
      for (const input of inputs) {
        const source = sources[paths.indexOf(input.path)];
        if (!source) return Effect.fail(invalid());
        files.set(input.name, source);
      }
      return tools.call(agentId, input, files, requestId);
    },
    (sources) => Effect.promise(() => Promise.allSettled(sources.map((source) => source.handle.close()))),
  );
});

export interface ApiChannelToolCallbacks {
  call(input: InvokeApiChannelInput): Effect.Effect<ApiChannelRun, { message: string }>;
  download(artifactId: string): Effect.Effect<DynamicToolResult, { message: string }>;
}

export function handleApiChannelTool(
  request: ApiChannelToolRequest,
  agentId: string,
  tools: ApiChannelTools,
  callbacks: ApiChannelToolCallbacks,
): Effect.Effect<DynamicToolResult> {
  return Effect.gen(function* () {
    switch (request.tool) {
      case "list_api_channels": {
        const templates = tools.templates?.() ?? [];
        if (request.templateId) {
          const template = templates.find((candidate) => candidate.id === request.templateId);
          return template ? openBotToolResult({ template }) : openBotToolFailure(invalid().message);
        }
        return openBotToolResult({
          channels: tools.list().map((channel) => ({
            id: channel.id,
            name: channel.definition.name,
            description: channel.definition.description,
            enabled: channel.enabled,
            source: channel.source,
            credentialStatus: channel.credentialStatus,
            operations: channel.definition.operations.map((operation) => ({
              id: operation.id,
              name: operation.name,
              description: operation.description,
              parameters: operation.parameters,
              readOnly: operation.readOnly,
              asynchronous: operation.job !== null,
            })),
          })),
          templates: templates.map(({ id, name, description }) => ({ id, name, description })),
        });
      }
      case "create_api_channel_draft":
        return openBotToolResult(yield* tools.createDraft(agentId, request.definitionJson));
      case "call_api_channel":
        return openBotToolResult(
          yield* callbacks.call({
            channelId: request.channelId,
            operationId: request.operationId,
            valuesJson: request.valuesJson,
          }),
        );
      case "get_api_channel_run":
        return openBotToolResult(yield* tools.poll(agentId, request.runId));
      case "download_api_channel_artifact":
        return yield* callbacks.download(request.artifactId);
    }
  }).pipe(Effect.catch((failure) => Effect.succeed(openBotToolFailure(failure.message))));
}

/** Provider cancellation interrupts the upload, HTTP request, polling, or artifact transfer. */
export function withApiChannelRequestCancellation<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    if (signal?.aborted) return Effect.interrupt;
    if (!signal) return operation;
    const cancelled = Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
    return operation.pipe(Effect.raceFirst(cancelled));
  });
}
