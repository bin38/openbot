import { type CustomProviderModelSyncState, isCustomProviderModelSyncState } from "@openbot/contracts/ipc";

export function decodeCustomProviderModelSyncStates(value: unknown): CustomProviderModelSyncState[] {
  if (!Array.isArray(value) || !value.every(isCustomProviderModelSyncState))
    throw new Error("Invalid custom provider model synchronization state.");
  return value;
}
