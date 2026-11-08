import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type GeminiProxyPort = Pick<OpenBotDesktopApi["geminiProxy"], "getSettings" | "setSettings">;

/** This preference belongs to the local host. A joined server never receives these calls. */
export function geminiProxyPort(): GeminiProxyPort {
  return window.openbot.geminiProxy;
}
