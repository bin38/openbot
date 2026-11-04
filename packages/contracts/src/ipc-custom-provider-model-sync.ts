import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString } from "./ipc-bounded-values";
import {
  CUSTOM_PROVIDER_LOCAL_MODEL_LIMIT,
  CUSTOM_PROVIDER_RESTARTS,
  type CustomProviderRestart,
  isCustomProviderId,
} from "./ipc-custom-providers";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/** Local-only sync settings. Released Team API endpoint records remain unchanged. */
export interface CustomProviderModelSyncState {
  id: string;
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailure: "failed" | null;
  lastRestart: CustomProviderRestart | null;
  upstreamCount: number | null;
  /** Kept so that an upstream removal never silently moves an agent to another model. */
  missingModelIds: string[];
  omittedModelCount: number;
}

export interface SetCustomProviderModelSyncInput {
  id: string;
  enabled: boolean;
}

export interface RefreshCustomProviderModelsInput {
  id: string;
}

const nullableDate = (value: unknown): value is string | null =>
  value === null || (isBoundedString(value, 64) && Number.isFinite(Date.parse(value)));
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isCustomProviderModelSyncState(value: unknown): value is CustomProviderModelSyncState {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).every((key) =>
      [
        "id",
        "enabled",
        "running",
        "lastAttemptAt",
        "lastSuccessAt",
        "lastFailure",
        "lastRestart",
        "upstreamCount",
        "missingModelIds",
        "omittedModelCount",
      ].includes(key),
    ) &&
    isCustomProviderId(value.id) &&
    typeof value.enabled === "boolean" &&
    typeof value.running === "boolean" &&
    nullableDate(value.lastAttemptAt) &&
    nullableDate(value.lastSuccessAt) &&
    (value.lastFailure === null || value.lastFailure === "failed") &&
    (value.lastRestart === null || isOneOf(CUSTOM_PROVIDER_RESTARTS, value.lastRestart)) &&
    (value.upstreamCount === null || count(value.upstreamCount)) &&
    count(value.omittedModelCount) &&
    Array.isArray(value.missingModelIds) &&
    value.missingModelIds.length <= CUSTOM_PROVIDER_LOCAL_MODEL_LIMIT &&
    value.missingModelIds.every((id) => isBoundedString(id, INPUT_LIMITS.identifier))
  );
}
