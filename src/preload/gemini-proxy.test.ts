import { describe, expect, it } from "vitest";
import { decodeGeminiProxySettings } from "./app-decoding";

describe("Gemini proxy response boundary", () => {
  it("returns only a valid local proxy preference", () => {
    expect(decodeGeminiProxySettings({ enabled: true, proxyUrl: "http://127.0.0.1:7897" })).toEqual({
      enabled: true,
      proxyUrl: "http://127.0.0.1:7897",
    });
    expect(decodeGeminiProxySettings({ enabled: false, proxyUrl: "https://proxy.example" }).enabled).toBe(false);
  });
  it("rejects secrets, non-HTTP transports and malformed responses", () => {
    for (const value of [
      null,
      {},
      { enabled: 1, proxyUrl: "http://127.0.0.1:7897" },
      { enabled: true, proxyUrl: "socks5://127.0.0.1:7897" },
      { enabled: true, proxyUrl: "http://user:secret@proxy.example" },
      { enabled: true, proxyUrl: "http://127.0.0.1:7897", token: "secret" },
    ]) {
      expect(() => decodeGeminiProxySettings(value)).toThrow("Invalid Gemini proxy settings response.");
    }
  });
});
