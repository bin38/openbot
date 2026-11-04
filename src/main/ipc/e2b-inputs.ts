import {
  E2B_MAX_TIMEOUT_MINUTES,
  E2B_MIN_TIMEOUT_MINUTES,
  type E2bAgentInput,
  type E2bTakeoverInput,
  type E2bViewerBoundsInput,
  type SaveE2bSettingsInput,
} from "@openbot/contracts/ipc";
import { z } from "zod";

const agentSchema = z.strictObject({ agentId: z.string().trim().min(1).max(128) });
const boundsSchema = z.strictObject({
  x: z.number().finite().min(0).max(32_768),
  y: z.number().finite().min(0).max(32_768),
  width: z.number().finite().positive().max(32_768),
  height: z.number().finite().positive().max(32_768),
});
const takeoverSchema = agentSchema.extend({ bounds: boundsSchema.optional() });
const viewerBoundsSchema = agentSchema.extend({ bounds: boundsSchema.nullable() });

export function decodeE2bTakeoverInput(value: unknown): E2bTakeoverInput {
  const parsed = takeoverSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid cloud computer viewer request.");
  return parsed.data;
}

export function decodeE2bViewerBoundsInput(value: unknown): E2bViewerBoundsInput {
  const parsed = viewerBoundsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid cloud computer viewer bounds.");
  return parsed.data;
}
const settingsSchema = z
  .strictObject({
    template: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_./:-]+$/),
    timeoutMinutes: z.number().int().min(E2B_MIN_TIMEOUT_MINUTES).max(E2B_MAX_TIMEOUT_MINUTES),
    apiKey: z.string().trim().max(4096).optional(),
    clearApiKey: z.boolean().optional(),
    confirmKeyReplacement: z.boolean().optional(),
  })
  .refine((value) => !(value.clearApiKey && value.apiKey), "Do not save and remove a key together.");

export function decodeE2bAgentInput(value: unknown): E2bAgentInput {
  const parsed = agentSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid cloud computer agent request.");
  return parsed.data;
}

export function decodeE2bSettingsInput(value: unknown): SaveE2bSettingsInput {
  const parsed = settingsSchema.safeParse(value);
  // Zod diagnostics can contain the submitted key. Never export them across IPC.
  if (!parsed.success) throw new Error("Invalid cloud computer settings.");
  return parsed.data;
}
