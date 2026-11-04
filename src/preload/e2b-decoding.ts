import type { E2bMachine, E2bScreenshot, E2bSettings } from "@openbot/contracts/ipc";
import { decodeList, decodeRecord, requiredNumber, requiredString } from "@openbot/contracts/ipc-decoding";
import { type DynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";

function rejectCredentials(value: DynamicRecord): void {
  if (["apiKey", "key", "token", "password", "url", "viewerUrl", "trafficAccessToken"].some((key) => key in value)) {
    throw new Error("Cloud computer response contains credentials.");
  }
}

export function decodeE2bMachine(value: unknown): E2bMachine {
  const item = decodeRecord(value, "cloud computer");
  rejectCredentials(item);
  if (!isOneOf(["running", "paused", "unknown", "missing"] as const, item.state)) {
    throw new Error("Invalid cloud computer state.");
  }
  if (!isOneOf(["agent", "human"] as const, item.control)) throw new Error("Invalid cloud computer control.");
  return {
    agentId: requiredString(item, "agentId"),
    sandboxId: requiredString(item, "sandboxId"),
    state: item.state,
    control: item.control,
    createdAt: requiredString(item, "createdAt"),
    updatedAt: requiredString(item, "updatedAt"),
  };
}

export function decodeE2bMachines(value: unknown): E2bMachine[] {
  return decodeList(value, "cloud computers", decodeE2bMachine);
}

export function decodeE2bStatus(value: unknown): E2bMachine | null {
  return value === null ? null : decodeE2bMachine(value);
}

export function decodeE2bSettings(value: unknown): E2bSettings {
  const item = decodeRecord(value, "cloud computer settings");
  rejectCredentials(item);
  if (!isOneOf(["saved", "missing", "unreadable"] as const, item.credentialStatus)) {
    throw new Error("Invalid cloud computer credential status.");
  }
  const timeoutMinutes = requiredNumber(item, "timeoutMinutes");
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    throw new Error("Invalid cloud computer timeout.");
  }
  return {
    credentialStatus: item.credentialStatus,
    template: requiredString(item, "template"),
    timeoutMinutes,
    machines: decodeE2bMachines(item.machines),
    pendingAgentIds: decodePendingAgentIds(item.pendingAgentIds),
  };
}

function decodePendingAgentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || item.length > 128)) {
    throw new Error("Invalid pending cloud computer creation.");
  }
  return value;
}

export function decodeE2bScreenshot(value: unknown): E2bScreenshot {
  const item = decodeRecord(value, "cloud computer screenshot");
  if (item.mimeType !== "image/png") throw new Error("Invalid cloud computer screenshot type.");
  const base64 = requiredString(item, "base64");
  if (base64.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) {
    throw new Error("Invalid cloud computer screenshot data.");
  }
  return { mimeType: "image/png", base64 };
}
