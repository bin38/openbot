import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ColabService } from "../colab-service";
import { agentWorkspacesIpcHandlers } from "./agent-workspaces-handlers";
import { colabIpcHandlers } from "./colab-handlers";
import { registerIpcGroup } from "./define-ipc-group";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, listener: (event: unknown, ...args: unknown[]) => unknown) => listeners.set(name, listener),
  },
}));
const foreign = { senderFrame: { url: "https://foreign.example/" } };
describe("local workspace and Colab IPC sender boundary", () => {
  it("does not open a native chooser for a foreign sender", () => {
    let chosen = 0;
    const info = {
      agentId: "one",
      path: "/one",
      managedPath: "/one",
      sharedPath: "/shared",
      custom: false,
      available: true,
    };
    registerIpcGroup(
      "agentWorkspaces",
      agentWorkspacesIpcHandlers({
        service: { getAgentWorkspace: () => Effect.succeed(info), setAgentWorkspace: () => Effect.succeed(info) },
        chooseDirectory: async () => {
          chosen += 1;
          return null;
        },
        openDirectory: async () => {},
      }).agentWorkspaces,
    );
    expect(() => listeners.get("agent-workspaces:choose")?.(foreign, "one")).toThrow("untrusted renderer");
    expect(chosen).toBe(0);
  });
  it("rejects foreign Colab code and login requests before reading or starting them", () => {
    const colab = new ColabService({ artifactsDirectory: "/unused-colab-boundary-fixture" });
    const start = vi.spyOn(colab, "startLogin");
    let reads = 0;
    const payload = Object.defineProperty({}, "code", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "fixture-secret";
      },
    });
    registerIpcGroup("colab", colabIpcHandlers({ colab, openLink: async () => {} }).colab);
    expect(() => listeners.get("colab:submit-login-code")?.(foreign, payload)).toThrow("untrusted renderer");
    expect(() => listeners.get("colab:start-login")?.(foreign)).toThrow("untrusted renderer");
    expect(reads).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
});
