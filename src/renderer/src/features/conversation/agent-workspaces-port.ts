import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type AgentWorkspacesApi = OpenBotDesktopApi["agentWorkspaces"];

/** Only the local agent settings mount this port. */
export function agentWorkspacesPort(): AgentWorkspacesApi {
  return window.openbot.agentWorkspaces;
}
