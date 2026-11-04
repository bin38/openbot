import { describe, expect, it } from "vitest";
import { decodeE2bScreenshot, decodeE2bSettings } from "./e2b-decoding";

describe("cloud computer preload boundary", () => {
  const settings = {
    credentialStatus: "saved",
    template: "desktop",
    timeoutMinutes: 15,
    machines: [],
    pendingAgentIds: [],
  };
  it("accepts a credential-free settings snapshot", () => {
    expect(decodeE2bSettings(settings)).toEqual(settings);
  });
  it("does not expose credential fields sent by a faulty main process", () => {
    for (const field of ["apiKey", "password", "url", "viewerUrl", "token", "trafficAccessToken"]) {
      expect(() => decodeE2bSettings({ ...settings, [field]: "sensitive-value" })).toThrow();
    }
  });
  it("refuses malformed state and screenshot content", () => {
    expect(() => decodeE2bSettings({ ...settings, timeoutMinutes: Infinity })).toThrow();
    expect(() => decodeE2bSettings({ ...settings, credentialStatus: "plaintext" })).toThrow();
    expect(() => decodeE2bScreenshot({ mimeType: "text/html", base64: "PHNjcmlwdD4=" })).toThrow();
    expect(() => decodeE2bScreenshot({ mimeType: "image/png", base64: "<script>" })).toThrow();
  });
});
