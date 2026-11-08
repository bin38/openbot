import { INPUT_LIMITS } from "./input-limits";
import { isDynamicRecord } from "./runtime-values";

/** Local workspace preferences. A joined host keeps the existing workspace file routes. */
export interface AgentWorkspaceInfo {
  agentId: string;
  path: string;
  managedPath: string;
  sharedPath: string;
  custom: boolean;
  available: boolean;
}

export interface OpenAgentWorkspaceInput {
  agentId: string;
  location: "current" | "managed" | "shared";
}

export function isAgentWorkspaceInfo(value: unknown): value is AgentWorkspaceInfo {
  return (
    isDynamicRecord(value) &&
    typeof value.agentId === "string" &&
    value.agentId.length > 0 &&
    value.agentId.length <= INPUT_LIMITS.identifier &&
    typeof value.path === "string" &&
    value.path.length <= INPUT_LIMITS.path &&
    typeof value.managedPath === "string" &&
    value.managedPath.length <= INPUT_LIMITS.path &&
    typeof value.sharedPath === "string" &&
    value.sharedPath.length <= INPUT_LIMITS.path &&
    typeof value.custom === "boolean" &&
    typeof value.available === "boolean"
  );
}
