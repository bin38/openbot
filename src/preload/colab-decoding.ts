import {
  type ColabCommandResult,
  type ColabSnapshot,
  isColabCommandResult,
  isColabSnapshot,
} from "@openbot/contracts/ipc";

export function decodeColabSnapshot(value: unknown): ColabSnapshot {
  if (!isColabSnapshot(value)) throw new Error("Invalid Colab status response.");
  return value;
}
export function decodeColabCommandResult(value: unknown): ColabCommandResult {
  if (!isColabCommandResult(value)) throw new Error("Invalid Colab command response.");
  return value;
}
