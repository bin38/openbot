import { isDynamicRecord } from "./runtime-values";

/** Local desktop preference. It never travels through the released Team API. */
export interface GeminiProxySettings {
  enabled: boolean;
  proxyUrl: string;
}

export const DEFAULT_GEMINI_PROXY_SETTINGS: GeminiProxySettings = {
  enabled: false,
  proxyUrl: "http://127.0.0.1:7897",
};

/** Proxy credentials are not accepted in this plain preference file. */
export function normalizeGeminiProxyUrl(value: string): string | null {
  if (value.length > 2_048 || /\p{Cc}/u.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isGeminiProxySettings(value: unknown): value is GeminiProxySettings {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).every((key) => key === "enabled" || key === "proxyUrl") &&
    typeof value.enabled === "boolean" &&
    typeof value.proxyUrl === "string" &&
    normalizeGeminiProxyUrl(value.proxyUrl) !== null
  );
}
