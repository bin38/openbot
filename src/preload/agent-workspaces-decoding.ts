import { type AgentWorkspaceInfo, isAgentWorkspaceInfo } from "@openbot/contracts/ipc";

export function decodeAgentWorkspaceInfo(value: unknown): AgentWorkspaceInfo {
  if (!isAgentWorkspaceInfo(value)) throw new Error("Invalid agent workspace response.");
  return {
    agentId: value.agentId,
    path: value.path,
    managedPath: value.managedPath,
    sharedPath: value.sharedPath,
    custom: value.custom,
    available: value.available,
  };
}

export function decodeOptionalAgentWorkspaceInfo(value: unknown): AgentWorkspaceInfo | null {
  return value === null ? null : decodeAgentWorkspaceInfo(value);
}
