import { describe, expect, it } from "vitest";
import { decodeColabCommandResult, decodeColabSnapshot } from "./colab-decoding";

const status = {
  installed: true,
  cliPath: "/tools/colab",
  version: "0.7.5",
  credentialsPresent: true,
  connected: true,
  loginPhase: "connected",
  canOpenAuthorization: false,
  message: null,
  sessions: [{ name: "runtime-1", hardware: "CPU", shape: "Standard", state: "idle" }],
  unmanagedSessions: 0,
  refreshedAt: 123,
};

describe("Colab preload response boundary", () => {
  it("keeps safe CLI and runtime metadata", () => {
    expect(decodeColabSnapshot(status)).toEqual(status);
    expect(decodeColabCommandResult({ text: "2", truncated: false })).toEqual({ text: "2", truncated: false });
  });
  it("rejects credential-bearing and malformed metadata", () => {
    for (const value of [
      null,
      { ...status, token: "private" },
      { ...status, loginPhase: "unrecognized" },
      { ...status, sessions: [{ ...status.sessions[0], token: "private" }] },
      { ...status, version: 2 },
      { ...status, refreshedAt: -1 },
      { ...status, unmanagedSessions: -1 },
    ])
      expect(() => decodeColabSnapshot(value)).toThrow("Invalid Colab status response.");
    expect(() => decodeColabCommandResult({ text: "x", truncated: false, refreshToken: "private" })).toThrow(
      "Invalid Colab command response.",
    );
  });
});
