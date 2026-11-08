import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { describe, expect, it } from "vitest";
import { decodeAgentWorkspaceInfo, decodeOptionalAgentWorkspaceInfo } from "./agent-workspaces-decoding";

const info = {
  agentId: "agent-1",
  path: "/projects/one",
  managedPath: "/private/one",
  sharedPath: "/shared",
  custom: true,
  available: false,
};
describe("local workspace response boundary", () => {
  it("preserves unavailable workspaces for repair and drops unrelated data", () => {
    expect(decodeAgentWorkspaceInfo({ ...info, password: "fixture-secret" })).toEqual(info);
    expect(decodeOptionalAgentWorkspaceInfo(null)).toBeNull();
  });
  it("rejects malformed paths and state before renderer use", () => {
    for (const value of [
      null,
      {},
      { ...info, path: 1 },
      { ...info, custom: "yes" },
      { ...info, path: "x".repeat(INPUT_LIMITS.path + 1) },
    ])
      expect(() => decodeAgentWorkspaceInfo(value)).toThrow();
  });
});
