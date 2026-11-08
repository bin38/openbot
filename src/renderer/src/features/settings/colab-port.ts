import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type ColabPort = OpenBotDesktopApi["colab"];
export function colabPort(): ColabPort {
  return window.openbot.colab;
}
