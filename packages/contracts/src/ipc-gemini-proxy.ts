import { isDynamicRecord } from "./runtime-values";

/** Local preference. Passwords are write-only and never travel through the released Team API. */
export interface GeminiProxySettings {
  enabled: boolean;
  proxyUrl: string;
  /** Legacy callers may omit the flags. Upstream credentials are never returned. */
  hasUsername?: boolean;
  hasPassword?: boolean;
}
export interface SetGeminiProxySettingsInput {
  enabled: boolean;
  proxyUrl: string;
  username?: string;
  /** Omitted or blank keeps the saved password for the same address and username. */
  password?: string;
  clearPassword?: boolean;
}
export const DEFAULT_GEMINI_PROXY_SETTINGS: GeminiProxySettings = {
  enabled: false,
  proxyUrl: "http://127.0.0.1:7897",
};

/** Credentials use separate write-only fields, never an address that can enter a diagnostic. */
export function normalizeGeminiProxyUrl(value: string): string | null {
  if (value.length > 2_048 || /\p{Cc}/u.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      !url.hostname
    )
      return null;
    if (url.protocol === "socks5:" || url.protocol === "socks5h:")
      return `socks5://${url.hostname}:${url.port || "1080"}`;
    return url.origin;
  } catch {
    return null;
  }
}
export function isGeminiProxyUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).length <= 255
  );
}
export function isGeminiProxySettings(value: unknown): value is GeminiProxySettings {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).every((key) => ["enabled", "proxyUrl", "hasUsername", "hasPassword"].includes(key)) &&
    typeof value.enabled === "boolean" &&
    typeof value.proxyUrl === "string" &&
    normalizeGeminiProxyUrl(value.proxyUrl) !== null &&
    (value.hasUsername === undefined || typeof value.hasUsername === "boolean") &&
    (value.hasPassword === undefined || typeof value.hasPassword === "boolean")
  );
}
export function isSetGeminiProxySettingsInput(value: unknown): value is SetGeminiProxySettingsInput {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).every((key) => ["enabled", "proxyUrl", "username", "password", "clearPassword"].includes(key)) &&
    typeof value.enabled === "boolean" &&
    typeof value.proxyUrl === "string" &&
    normalizeGeminiProxyUrl(value.proxyUrl) !== null &&
    (value.username === undefined || isGeminiProxyUsername(value.username)) &&
    (value.password === undefined ||
      (typeof value.password === "string" &&
        value.password.length <= 255 &&
        new TextEncoder().encode(value.password).length <= 255)) &&
    (value.clearPassword === undefined || typeof value.clearPassword === "boolean")
  );
}
