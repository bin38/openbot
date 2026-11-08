import type { GeminiProxySettings } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { registerIpcGroup } from "./define-ipc-group";
import { geminiProxyIpcHandlers } from "./gemini-proxy-handlers";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
      listeners.set(channel, listener),
  },
}));

describe("Gemini proxy IPC boundary", () => {
  it("rejects foreign senders before reading their payload", () => {
    let reads = 0;
    const payload = Object.defineProperty({}, "enabled", {
      enumerable: true,
      get: () => {
        reads += 1;
        return true;
      },
    });
    registerIpcGroup(
      "geminiProxy",
      geminiProxyIpcHandlers({
        settings: {
          get: () => ({ enabled: false, proxyUrl: "http://127.0.0.1:7897" }),
          set: (value) => Effect.succeed(value),
        },
        restartGemini: () => Effect.void,
      }).geminiProxy,
    );
    const invoke = listeners.get("gemini-proxy:set-settings");
    expect(invoke).toBeDefined();
    expect(() => invoke?.({ senderFrame: { url: "https://untrusted.example" } }, payload)).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(reads).toBe(0);
  });

  it("rejects invalid or credential-bearing URLs without writing or exposing input", () => {
    let writes = 0;
    let restarts = 0;
    registerIpcGroup(
      "geminiProxy",
      geminiProxyIpcHandlers({
        settings: {
          get: () => ({ enabled: false, proxyUrl: "http://127.0.0.1:7897" }),
          set: (value) =>
            Effect.sync(() => {
              writes += 1;
              return value;
            }),
        },
        restartGemini: () =>
          Effect.sync(() => {
            restarts += 1;
          }),
      }).geminiProxy,
    );
    const invoke = listeners.get("gemini-proxy:set-settings");
    expect(invoke).toBeDefined();
    const sender = { senderFrame: { url: "openbot-app://app/index.html" } };
    for (const proxyUrl of [
      "socks5://127.0.0.1:7897",
      "http://user:fixture-secret@proxy.example",
      "https://proxy.example/path",
      "https://proxy.example/?key=fixture-secret",
      "http://127.0.0.1:70000",
      "http://127.0.0.1:\n7897",
      "x".repeat(2049),
    ]) {
      expect(() => invoke?.(sender, { enabled: true, proxyUrl })).toThrow(
        "Enter an HTTP or HTTPS proxy address without credentials, a path or a query.",
      );
    }
    expect(() => invoke?.(sender, { enabled: "true", proxyUrl: "http://127.0.0.1:7897" })).toThrow();
    expect(writes).toBe(0);
    expect(restarts).toBe(0);
  });

  it("saves a valid local request and schedules only the supplied Gemini restart", async () => {
    let saved: GeminiProxySettings = { enabled: false, proxyUrl: "http://127.0.0.1:7897" };
    let restarts = 0;
    registerIpcGroup(
      "geminiProxy",
      geminiProxyIpcHandlers({
        settings: {
          get: () => ({ ...saved }),
          set: (value) =>
            Effect.sync(() => {
              saved = value;
              return { ...saved };
            }),
        },
        restartGemini: () =>
          Effect.sync(() => {
            restarts += 1;
          }),
      }).geminiProxy,
    );
    const invoke = listeners.get("gemini-proxy:set-settings");
    expect(invoke).toBeDefined();
    const sender = { senderFrame: { url: "openbot-app://app/index.html" } };
    expect(await invoke?.(sender, { enabled: true, proxyUrl: " http://127.0.0.1:7897/ " })).toEqual({
      enabled: true,
      proxyUrl: "http://127.0.0.1:7897",
    });
    expect(restarts).toBe(1);
    expect(saved.enabled).toBe(true);
  });
});
