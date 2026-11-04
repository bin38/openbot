import { describe, expect, it } from "vitest";
import { decodeE2bTakeoverInput, decodeE2bViewerBoundsInput } from "./e2b-inputs";

describe("cloud viewer IPC payload boundary", () => {
  const bounds = { x: 400, y: 100, width: 600, height: 500 };
  it("preserves the separate-window request and admits an embedded rectangle", () => {
    expect(decodeE2bTakeoverInput({ agentId: "agent" })).toEqual({ agentId: "agent" });
    expect(decodeE2bTakeoverInput({ agentId: "agent", bounds })).toEqual({ agentId: "agent", bounds });
    expect(decodeE2bViewerBoundsInput({ agentId: "agent", bounds: null })).toEqual({ agentId: "agent", bounds: null });
  });
  it.each([
    { ...bounds, x: -1 },
    { ...bounds, y: Number.NaN },
    { ...bounds, width: Number.POSITIVE_INFINITY },
    { ...bounds, width: 0 },
    { ...bounds, height: 100_000 },
    { ...bounds, url: "file:///etc/passwd" },
  ])("rejects invalid and extended rectangles without echoing the payload", (rectangle) => {
    expect(() => decodeE2bViewerBoundsInput({ agentId: "agent", bounds: rectangle })).toThrow(
      "Invalid cloud computer viewer bounds.",
    );
  });
  it("rejects a renderer-supplied viewer URL or token", () => {
    expect(() => decodeE2bTakeoverInput({ agentId: "agent", bounds, url: "https://attacker.example" })).toThrow();
    expect(() => decodeE2bTakeoverInput({ agentId: "agent", bounds, trafficAccessToken: "do-not-echo" })).toThrow(
      "Invalid cloud computer viewer request.",
    );
  });
});
