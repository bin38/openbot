import { describe, expect, it } from "vitest";
import {
  e2bViewerHeaders,
  e2bViewerOrigin,
  e2bViewerRectangle,
  isE2bViewerResource,
  requireE2bViewerSender,
} from "./e2b-viewer-policy";

describe("cloud viewer isolation", () => {
  const origin = "https://6080-example.e2b.app";
  it("allows only the current main renderer to place or close an embedded viewer", () => {
    expect(() => requireE2bViewerSender(12, 12)).not.toThrow();
    expect(() => requireE2bViewerSender(13, 12)).toThrow();
    expect(() => requireE2bViewerSender(12, null)).toThrow();
  });
  it("clips an embedded viewer to its parent content area after interface zoom", () => {
    expect(e2bViewerRectangle({ x: 400, y: 80, width: 600, height: 800 }, 1.25, 1000, 700)).toEqual({
      x: 500,
      y: 100,
      width: 500,
      height: 600,
    });
    expect(e2bViewerRectangle(null, 1, 1000, 700)).toBeNull();
    expect(e2bViewerRectangle({ x: 1000, y: 0, width: 600, height: 800 }, 1, 1000, 700)).toBeNull();
  });
  it("admits an authenticated E2B viewer and its own secure websocket", () => {
    expect(e2bViewerOrigin(`${origin}/vnc.html?password=private-viewer-key`)).toBe(origin);
    expect(isE2bViewerResource(`${origin}/app/ui.js`, origin)).toBe(true);
    expect(isE2bViewerResource("wss://6080-example.e2b.app/websockify", origin)).toBe(true);
  });
  it.each([
    "http://6080-example.e2b.app/vnc.html?password=secret",
    "https://6080-example.e2b.app.evil.test/vnc.html?password=secret",
    "https://6080-example.e2b.app@evil.test/vnc.html?password=secret",
    "https://user:secret@6080-example.e2b.app/vnc.html?password=secret",
    "https://6080-example.e2b.app:8443/vnc.html?password=secret",
    "https://6080-example.e2b.app/vnc.html",
    "file:///tmp/vnc.html?password=secret",
  ])("refuses an untrusted or unauthenticated viewer", (url) => {
    expect(() => e2bViewerOrigin(url)).toThrow();
  });
  it("blocks requests that could leak a viewer credential to another origin", () => {
    for (const url of [
      "https://evil.test/collect",
      "https://6080-another.e2b.app/",
      "http://6080-example.e2b.app/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      expect(isE2bViewerResource(url, origin)).toBe(false);
    }
  });
  it("authenticates private HTTP assets and WebSocket upgrades without changing the source headers", () => {
    const input = { Accept: "*/*", "E2B-Traffic-Access-Token": "untrusted-value" };
    for (const url of [`${origin}/vnc.html`, "wss://6080-example.e2b.app/websockify"]) {
      expect(e2bViewerHeaders(url, origin, "fixture-traffic-token", input)).toEqual({
        Accept: "*/*",
        "e2b-traffic-access-token": "fixture-traffic-token",
      });
    }
    expect(input["E2B-Traffic-Access-Token"]).toBe("untrusted-value");
  });
  it("never sends a traffic credential to another sandbox, an insecure URL, or an inline resource", () => {
    for (const url of [
      "https://6080-other.e2b.app/",
      "https://evil.test/",
      "http://6080-example.e2b.app/",
      "data:text/plain,hello",
      "blob:https://6080-example.e2b.app/one",
    ]) {
      expect(e2bViewerHeaders(url, origin, "fixture-traffic-token", { "E2B-Traffic-Access-Token": "old" })).toEqual({});
    }
    expect(() => e2bViewerHeaders(origin, origin, "invalid\r\nheader", {})).toThrow(
      "Invalid cloud viewer access token.",
    );
  });
});
