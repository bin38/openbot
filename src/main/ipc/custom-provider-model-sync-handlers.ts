import {
  isCustomProviderId,
  type RefreshCustomProviderModelsInput,
  type SetCustomProviderModelSyncInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result } from "effect";
import type { CustomProviderModelSync, CustomProviderModelSyncFailure } from "../custom-provider-model-sync";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

function decodeRefreshCustomProviderModelsInput(value: unknown): RefreshCustomProviderModelsInput {
  if (!isDynamicRecord(value) || Object.keys(value).some((key) => key !== "id") || !isCustomProviderId(value.id))
    throw new Error("Invalid custom provider model refresh.");
  return { id: value.id };
}

function decodeSetCustomProviderModelSyncInput(value: unknown): SetCustomProviderModelSyncInput {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).some((key) => key !== "id" && key !== "enabled") ||
    !isCustomProviderId(value.id) ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("Invalid custom provider model synchronization setting.");
  return { id: value.id, enabled: value.enabled };
}

async function runSync<A>(operation: Effect.Effect<A, CustomProviderModelSyncFailure>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

export function customProviderModelSyncIpcHandlers(
  sync: CustomProviderModelSync,
): Pick<IpcGroupHandlers, "customProviderModelSync"> {
  return {
    customProviderModelSync: {
      list: handler(() => sync.list()),
      refresh: payloadHandler(decodeRefreshCustomProviderModelsInput, ({ id }) => runSync(sync.refresh(id))),
      setEnabled: payloadHandler(decodeSetCustomProviderModelSyncInput, (input) => runSync(sync.setEnabled(input))),
    },
  };
}
