import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type ProjectWorkspacesApi = OpenBotDesktopApi["projectWorkspaces"];

/** Local project selection never uses the selected remote host's transport. */
export function projectWorkspacesPort(): ProjectWorkspacesApi {
  return window.openbot.projectWorkspaces;
}
