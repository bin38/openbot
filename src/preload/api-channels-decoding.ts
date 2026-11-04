import {
  API_CHANNEL_PUBLIC_LIMITS,
  type ApiChannelDefinition,
  type ApiChannelRun,
  type ApiChannelRunSummary,
  type ApiChannelSummary,
  type ApiChannelTemplate,
  isApiChannelDefinition,
  isApiChannelRun,
  isApiChannelRunSummary,
  isApiChannelSummary,
  isApiChannelTemplate,
} from "@openbot/contracts/ipc";

export function decodeApiChannelDefinition(value: unknown): ApiChannelDefinition {
  if (!isApiChannelDefinition(value)) throw new Error("Invalid public API endpoint definition.");
  return value;
}
export function decodeApiChannelSummary(value: unknown): ApiChannelSummary {
  if (!isApiChannelSummary(value)) throw new Error("Invalid public API endpoint summary.");
  return value;
}
export function decodeApiChannelSummaries(value: unknown): ApiChannelSummary[] {
  if (!Array.isArray(value) || value.length > API_CHANNEL_PUBLIC_LIMITS.channels || !value.every(isApiChannelSummary))
    throw new Error("Invalid public API endpoint list.");
  return value;
}
export function decodeApiChannelTemplates(value: unknown): ApiChannelTemplate[] {
  if (!Array.isArray(value) || value.length > API_CHANNEL_PUBLIC_LIMITS.templates || !value.every(isApiChannelTemplate))
    throw new Error("Invalid public API endpoint templates.");
  return value;
}
export function decodeApiChannelRun(value: unknown): ApiChannelRun {
  if (!isApiChannelRun(value)) throw new Error("Invalid public API endpoint result.");
  return value;
}
export function decodeApiChannelRunSummaries(value: unknown): ApiChannelRunSummary[] {
  if (!Array.isArray(value) || value.length > API_CHANNEL_PUBLIC_LIMITS.runs || !value.every(isApiChannelRunSummary))
    throw new Error("Invalid public API endpoint run history.");
  return value;
}
