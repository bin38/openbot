import {
  COLAB_LIMITS,
  type ColabCommandResult,
  type ColabCreateInput,
  type ColabExecuteInput,
  type ColabFilesInput,
  type ColabSnapshot,
  isColabSessionName,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import type { GeneratedAttachmentSource } from "../attachment-files";
import { colabFailure } from "../colab-errors";
import type { DynamicToolResult } from "../protocol";
import type { AttachmentGateway } from "./attachment-gateway";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

/** Main owns Google credentials and CLI processes. File sources are opened by the calling agent's attachment gateway. */
export interface ColabTools {
  getStatus(): Effect.Effect<ColabSnapshot, { message: string }>;
  refresh(): Effect.Effect<ColabSnapshot, { message: string }>;
  createCpu(input: ColabCreateInput): Effect.Effect<ColabSnapshot, { message: string }>;
  stop(session: string): Effect.Effect<ColabSnapshot, { message: string }>;
  execute(input: ColabExecuteInput): Effect.Effect<ColabCommandResult, { message: string }>;
  listFiles(input: ColabFilesInput): Effect.Effect<ColabCommandResult, { message: string }>;
  uploadSource(
    session: string,
    remotePath: string,
    source: GeneratedAttachmentSource,
  ): Effect.Effect<{ remotePath: string; bytes: number }, { message: string }>;
  executeNotebookSource(
    session: string,
    source: GeneratedAttachmentSource,
    timeoutSeconds?: number,
  ): Effect.Effect<ColabCommandResult, { message: string }>;
  download<A, E>(
    session: string,
    remotePath: string,
    fileName: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | { message: string }>;
}

const session = z.string().refine(isColabSessionName);
const path = z.string().min(1).max(COLAB_LIMITS.path);
const seconds = z.number().int().min(1).max(COLAB_LIMITS.timeoutSeconds).optional();
const empty = z.strictObject({});
const create = z.strictObject({ name: session });
const stop = z.strictObject({ session });
const execute = z.strictObject({ session, code: z.string().min(1).max(COLAB_LIMITS.code), timeoutSeconds: seconds });
const files = z.strictObject({ session, path });
const upload = z.strictObject({ session, localPath: path, remotePath: path });
const notebook = z.strictObject({ session, localPath: path, timeoutSeconds: seconds });
const download = z.strictObject({ session, remotePath: path, fileName: z.string().min(1).max(255) });

export const COLAB_TOOL_DEFINITIONS = [
  {
    name: "colab_status",
    description:
      "Read local Colab CLI and Google sign-in readiness. Does not start login, create a runtime or spend compute quota.",
    shape: empty.shape,
  },
  {
    name: "list_colab_sessions",
    description:
      "List this account's named Colab CLI runtimes. Sign in through Server settings first; never create a runtime just to check status.",
    shape: empty.shape,
  },
  {
    name: "create_colab_cpu_session",
    description:
      "Only on a user request for remote compute, create a CPU-only Colab runtime. Reuse the same name on retry. Uses the user's Colab quota; never purchases compute units or chooses a paid accelerator.",
    shape: create.shape,
  },
  {
    name: "stop_colab_session",
    description:
      "Only on an explicit user request, shut down a named Colab runtime. Files kept only on that VM can be lost; download needed results first. Do not stop a runtime merely because a listing or command failed.",
    shape: stop.shape,
  },
  {
    name: "execute_colab_code",
    description:
      "Run Python in a listed Colab runtime. Code and its output go to Google and may change remote files/use quota. Do not send local credentials. Use only when the user's task needs remote execution.",
    shape: execute.shape,
  },
  {
    name: "list_colab_files",
    description: "List remote files in a named Colab runtime, without uploading or creating a VM.",
    shape: files.shape,
  },
  {
    name: "upload_colab_file",
    description:
      "Upload an approved regular file from your workspace, Shared or allowed folders to a named Colab runtime. Never upload credentials or files outside that scope.",
    shape: upload.shape,
  },
  {
    name: "execute_colab_notebook",
    description:
      "Run a workspace .ipynb in a named Colab runtime. A private copy is executed; the original local notebook is not changed. Code/results go to Google and use the account's quota.",
    shape: notebook.shape,
  },
  {
    name: "download_colab_file",
    description:
      "Deliver a remote Colab file to this chat through a managed attachment. Supply a filename only, not a local output path.",
    shape: download.shape,
  },
];

export type ColabToolRequest =
  | { tool: "colab_status" | "list_colab_sessions" }
  | { tool: "create_colab_cpu_session"; name: string }
  | { tool: "stop_colab_session"; session: string }
  | ({ tool: "execute_colab_code" } & ColabExecuteInput)
  | ({ tool: "list_colab_files" } & ColabFilesInput)
  | { tool: "upload_colab_file"; session: string; localPath: string; remotePath: string }
  | { tool: "execute_colab_notebook"; session: string; localPath: string; timeoutSeconds?: number | undefined }
  | { tool: "download_colab_file"; session: string; remotePath: string; fileName: string };

export function isColabTool(tool: string): boolean {
  return COLAB_TOOL_DEFINITIONS.some((definition) => definition.name === tool);
}
export function parseColabToolRequest(tool: string, args: unknown): ColabToolRequest | null {
  switch (tool) {
    case "colab_status":
    case "list_colab_sessions":
      return empty.safeParse(args).success ? { tool } : null;
    case "create_colab_cpu_session": {
      const parsed = create.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "stop_colab_session": {
      const parsed = stop.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "execute_colab_code": {
      const parsed = execute.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "list_colab_files": {
      const parsed = files.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "upload_colab_file": {
      const parsed = upload.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "execute_colab_notebook": {
      const parsed = notebook.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    case "download_colab_file": {
      const parsed = download.safeParse(args);
      return parsed.success ? { tool, ...parsed.data } : null;
    }
    default:
      return null;
  }
}

export const withColabSource = Effect.fn("ColabTools.withSource")(function* <A>(
  agentId: string,
  localPath: string,
  attachments: Pick<AttachmentGateway, "openSources">,
  consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, { message: string }>,
) {
  return yield* Effect.acquireUseRelease(
    attachments
      .openSources(agentId, [localPath], { allowAnyReadablePath: false })
      .pipe(Effect.mapError(() => colabFailure("file"))),
    (sources) => (sources[0] ? consume(sources[0]) : Effect.fail(colabFailure("file"))),
    (sources) => Effect.promise(() => Promise.allSettled(sources.map((source) => source.handle.close()))),
  );
});

export interface ColabToolCallbacks {
  upload(
    session: string,
    localPath: string,
    remotePath: string,
  ): Effect.Effect<{ remotePath: string; bytes: number }, { message: string }>;
  notebook(
    session: string,
    localPath: string,
    timeoutSeconds?: number,
  ): Effect.Effect<ColabCommandResult, { message: string }>;
  download(
    session: string,
    remotePath: string,
    fileName: string,
  ): Effect.Effect<DynamicToolResult, { message: string }>;
}

function modelResult(result: ColabCommandResult): ColabCommandResult {
  if (result.text.length <= 16_000) return result;
  return {
    text:
      result.text.slice(0, 16_000) +
      "\n[Output shortened for model context. Save large results to a remote file and download it.]",
    truncated: true,
  };
}

export function handleColabTool(
  request: ColabToolRequest,
  tools: ColabTools,
  callbacks: ColabToolCallbacks,
): Effect.Effect<DynamicToolResult> {
  return Effect.gen(function* () {
    switch (request.tool) {
      case "colab_status": {
        const status = yield* tools.getStatus();
        return openBotToolResult({
          installed: status.installed,
          version: status.version,
          connected: status.connected,
          credentialsPresent: status.credentialsPresent,
          sessions: status.sessions,
        });
      }
      case "list_colab_sessions": {
        const status = yield* tools.refresh();
        return openBotToolResult({ sessions: status.sessions, unmanagedSessions: status.unmanagedSessions });
      }
      case "create_colab_cpu_session":
        return openBotToolResult({ sessions: (yield* tools.createCpu({ name: request.name })).sessions });
      case "stop_colab_session":
        return openBotToolResult({ sessions: (yield* tools.stop(request.session)).sessions });
      case "execute_colab_code":
        return openBotToolResult(
          modelResult(
            yield* tools.execute({
              session: request.session,
              code: request.code,
              ...(request.timeoutSeconds === undefined ? {} : { timeoutSeconds: request.timeoutSeconds }),
            }),
          ),
        );
      case "list_colab_files":
        return openBotToolResult(modelResult(yield* tools.listFiles({ session: request.session, path: request.path })));
      case "upload_colab_file":
        return openBotToolResult(yield* callbacks.upload(request.session, request.localPath, request.remotePath));
      case "execute_colab_notebook":
        return openBotToolResult(
          modelResult(yield* callbacks.notebook(request.session, request.localPath, request.timeoutSeconds)),
        );
      case "download_colab_file":
        return yield* callbacks.download(request.session, request.remotePath, request.fileName);
    }
  }).pipe(Effect.catch((failure) => Effect.succeed(openBotToolFailure(failure.message))));
}
