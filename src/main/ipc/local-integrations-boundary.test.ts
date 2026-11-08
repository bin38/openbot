import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ColabService } from "../colab-service";
import { agentWorkspacesIpcHandlers } from "./agent-workspaces-handlers";
import { colabIpcHandlers } from "./colab-handlers";
import { registerIpcGroup } from "./define-ipc-group";
import { projectWorkspacesIpcHandlers } from "./project-workspaces-handlers";

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
        inspectProject: (path) =>
          Effect.succeed({
            path,
            name: "fixture",
            available: true,
            git: { status: "none" },
            instructions: [],
            skills: [],
            truncated: false,
          }),
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
  it("rejects foreign project requests and direct path injection before native or agent operations", () => {
    let chosen = 0;
    let reads = 0;
    let resolved = 0;
    const unused = () => Effect.die(new Error("No project operation should run."));
    registerIpcGroup(
      "projectWorkspaces",
      projectWorkspacesIpcHandlers({
        projects: {
          list: () => [],
          remember: unused,
          inspect: unused,
          forget: unused,
          resolve: () => {
            resolved += 1;
            return unused();
          },
        },
        service: { createAgent: unused, setAgentWorkspace: unused },
        conversationSender: () => undefined,
        chooseDirectory: async () => {
          chosen += 1;
          return null;
        },
      }).projectWorkspaces,
    );
    const payload = Object.defineProperty({}, "projectId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "one";
      },
    });
    expect(() => listeners.get("project-workspaces:create")?.(foreign, payload)).toThrow("untrusted renderer");
    expect(() => listeners.get("project-workspaces:choose")?.(foreign)).toThrow("untrusted renderer");
    const trusted = { senderFrame: { url: "openbot-app://app/index.html" } };
    expect(() =>
      listeners.get("project-workspaces:create")?.(trusted, { projectId: "one", input: {}, path: "/unapproved" }),
    ).toThrow("Invalid project creation");
    expect(() =>
      listeners.get("project-workspaces:assign")?.(trusted, {
        projectId: "one",
        agentId: "agent",
        path: "/unapproved",
      }),
    ).toThrow("Invalid project assignment");
    expect(reads).toBe(0);
    expect(chosen).toBe(0);
    expect(resolved).toBe(0);
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
