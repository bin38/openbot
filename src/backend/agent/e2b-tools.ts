import {
  E2B_MAX_COMMAND_TIMEOUT_MS,
  type E2bCommandResult,
  type E2bDesktopInput,
  type E2bFileResult,
  type E2bMachine,
  type E2bScreenshot,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import type { GeneratedAttachmentSource } from "../attachment-files";
import type { DynamicToolResult } from "../protocol";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

/** Main owns E2B and its key. Tools receive only operations scoped to their calling agent. */
export interface E2bDesktopTools {
  status(agentId: string): Effect.Effect<E2bMachine | null, { message: string }>;
  start(agentId: string, actor: "agent"): Effect.Effect<E2bMachine, { message: string }>;
  pause(agentId: string, actor: "agent"): Effect.Effect<E2bMachine, { message: string }>;
  delete(agentId: string, actor: "agent"): Effect.Effect<void, { message: string }>;
  screenshot(agentId: string, actor: "agent"): Effect.Effect<E2bScreenshot, { message: string }>;
  execute(agentId: string, command: string, timeoutMs: number): Effect.Effect<E2bCommandResult, { message: string }>;
  input(agentId: string, input: E2bDesktopInput): Effect.Effect<void, { message: string }>;
  upload(agentId: string, localPath: string, remotePath: string): Effect.Effect<E2bFileResult, { message: string }>;
  download<A, E>(
    agentId: string,
    remotePath: string,
    fileName: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | { message: string }>;
}

const empty = z.strictObject({});
const commandSchema = z.strictObject({
  command: z.string().min(1).max(32_768),
  timeoutMs: z.number().int().min(1_000).max(E2B_MAX_COMMAND_TIMEOUT_MS).default(30_000),
});
const clickSchema = z.strictObject({
  x: z.number().int().min(0).max(16_384),
  y: z.number().int().min(0).max(16_384),
  button: z.enum(["left", "right", "double"]).default("left"),
});
const typeSchema = z.strictObject({ text: z.string().min(1).max(16_384) });
const keySchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_+ -]+$/),
});
const scrollSchema = z.strictObject({
  direction: z.enum(["up", "down"]),
  pixels: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(600)
    .describe("Approximate pixels; about 100 per wheel step, at most 20 steps per call."),
});
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const fileSchema = z.strictObject({ localPath: path, remotePath: path });
const downloadSchema = z.strictObject({
  remotePath: path,
  fileName: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => !/[\\/\0]/u.test(value) && value !== "." && value !== ".."),
});

export const E2B_TOOL_DEFINITIONS = [
  {
    name: "cloud_computer_status",
    description:
      "Read this agent's E2B status without starting/resuming it. Its cloud desktop is separate from the local computer.",
    shape: empty.shape,
  },
  {
    name: "cloud_computer_start",
    description:
      "Create/resume this agent's persistent E2B desktop with the key in Cloud computer settings; charges may apply. Pause/resume retains files. Never auto-replace expired or inaccessible computers.",
    shape: empty.shape,
  },
  {
    name: "cloud_computer_pause",
    description:
      "Pause this agent's E2B desktop; retain files and memory for resume. Unavailable during human control.",
    shape: empty.shape,
  },
  {
    name: "cloud_computer_delete",
    description: "Permanently delete this agent's E2B computer and files, only on the user's explicit request.",
    shape: empty.shape,
  },
  {
    name: "cloud_computer_screenshot",
    description:
      "Capture this agent's running E2B desktop before coordinate actions. Unavailable during human control.",
    shape: empty.shape,
  },
  {
    name: "cloud_computer_execute",
    description:
      "Run one bounded foreground command on this agent's running E2B computer, never locally. Output marks truncation; save/download large output as a file. No detached jobs past the deadline.",
    shape: commandSchema.shape,
  },
  {
    name: "cloud_computer_click",
    description: "Click this agent's running E2B desktop at coordinates from its latest screenshot.",
    shape: clickSchema.shape,
  },
  {
    name: "cloud_computer_type",
    description:
      "Type into this agent's focused E2B control. Ask the user to take over for passwords or sensitive sign-in steps.",
    shape: typeSchema.shape,
  },
  {
    name: "cloud_computer_key",
    description: "Press a key/shortcut on this agent's E2B desktop, such as Return, Tab or ctrl+l.",
    shape: keySchema.shape,
  },
  {
    name: "cloud_computer_scroll",
    description: "Scroll up or down on this agent's E2B desktop.",
    shape: scrollSchema.shape,
  },
  {
    name: "cloud_computer_upload",
    description:
      "Stream a regular workspace file to this agent's E2B computer: all types, no product size cap. Sends the selected file to E2B; never extracts archives.",
    shape: fileSchema.shape,
  },
  {
    name: "cloud_computer_download",
    description:
      "Stream a file of any type from this agent's E2B computer to a downloadable chat attachment. Supply a file name, not a host directory. Never executes or extracts it.",
    shape: downloadSchema.shape,
  },
];

export function isE2bTool(tool: string): boolean {
  return E2B_TOOL_DEFINITIONS.some((definition) => definition.name === tool);
}

/** Screenshot reads cloud contents and needs the same approval gate as a changing operation. */
export function isE2bMutationTool(tool: string): boolean {
  return isE2bTool(tool) && tool !== "cloud_computer_status";
}

function invalidArguments(): DynamicToolResult {
  return openBotToolFailure(
    "Invalid cloud computer arguments. Use the advertised fields and bounds; do not pass an agent or sandbox ID.",
  );
}

export function handleE2bTool(
  tool: string,
  args: unknown,
  agentId: string,
  tools: E2bDesktopTools | null,
  onDownload?: (remotePath: string, fileName: string) => Effect.Effect<DynamicToolResult, { message: string }>,
): Effect.Effect<DynamicToolResult | null> {
  if (!isE2bTool(tool)) return Effect.succeed(null);
  if (!tools) return Effect.succeed(openBotToolFailure("Cloud computers are unavailable on this host."));
  return Effect.gen(function* () {
    switch (tool) {
      case "cloud_computer_execute": {
        const parsed = commandSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        return openBotToolResult(yield* tools.execute(agentId, parsed.data.command, parsed.data.timeoutMs));
      }
      case "cloud_computer_click": {
        const parsed = clickSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        yield* tools.input(agentId, { kind: "click", ...parsed.data });
        return openBotToolResult({ done: true });
      }
      case "cloud_computer_type": {
        const parsed = typeSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        yield* tools.input(agentId, { kind: "type", ...parsed.data });
        return openBotToolResult({ done: true });
      }
      case "cloud_computer_key": {
        const parsed = keySchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        yield* tools.input(agentId, { kind: "key", ...parsed.data });
        return openBotToolResult({ done: true });
      }
      case "cloud_computer_scroll": {
        const parsed = scrollSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        yield* tools.input(agentId, { kind: "scroll", ...parsed.data });
        return openBotToolResult({ done: true });
      }
      case "cloud_computer_upload": {
        const parsed = fileSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        return openBotToolResult(yield* tools.upload(agentId, parsed.data.localPath, parsed.data.remotePath));
      }
      case "cloud_computer_download": {
        const parsed = downloadSchema.safeParse(args);
        if (!parsed.success) return invalidArguments();
        if (!onDownload) return openBotToolFailure("Cloud file delivery is unavailable in this chat.");
        return yield* onDownload(parsed.data.remotePath, parsed.data.fileName);
      }
      default: {
        if (!empty.safeParse(args).success) return invalidArguments();
        if (tool === "cloud_computer_start") return openBotToolResult(yield* tools.start(agentId, "agent"));
        if (tool === "cloud_computer_pause") return openBotToolResult(yield* tools.pause(agentId, "agent"));
        if (tool === "cloud_computer_delete") {
          yield* tools.delete(agentId, "agent");
          return openBotToolResult({ deleted: true });
        }
        if (tool === "cloud_computer_screenshot") {
          const screenshot = yield* tools.screenshot(agentId, "agent");
          return {
            success: true,
            contentItems: [
              { type: "inputImage" as const, imageUrl: `data:${screenshot.mimeType};base64,${screenshot.base64}` },
            ],
          };
        }
        return openBotToolResult({ machine: yield* tools.status(agentId) });
      }
    }
  }).pipe(Effect.catch((failure) => Effect.succeed(openBotToolFailure(failure.message))));
}
