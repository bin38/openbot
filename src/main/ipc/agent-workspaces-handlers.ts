import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { OpenAgentWorkspaceInput } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString, stringPayload } from "./validation";

const agentId = stringPayload("Agent id", INPUT_LIMITS.identifier);

function parseOpen(value: unknown): OpenAgentWorkspaceInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid workspace location.");
  const location = value.location;
  if (location !== "current" && location !== "managed" && location !== "shared")
    throw new Error("Invalid workspace location.");
  return { agentId: requireString(value.agentId, "Agent id"), location };
}

/** Local owner controls; no Team API route can select or reveal a host directory. */
export function agentWorkspacesIpcHandlers(dependencies: {
  service: Pick<AgentService, "getAgentWorkspace" | "setAgentWorkspace">;
  chooseDirectory: (current: string) => Promise<string | null>;
  openDirectory: (path: string) => Promise<void>;
}): Pick<IpcGroupHandlers, "agentWorkspaces"> {
  const { service, chooseDirectory, openDirectory } = dependencies;
  return {
    agentWorkspaces: {
      get: payloadHandler(agentId, (id) => runCauseEffect(service.getAgentWorkspace(id))),
      choose: payloadHandler(agentId, async (id) => {
        const current = await runCauseEffect(service.getAgentWorkspace(id));
        const selected = await chooseDirectory(current.path);
        return selected === null ? null : runCauseEffect(service.setAgentWorkspace(id, selected));
      }),
      reset: payloadHandler(agentId, (id) => runCauseEffect(service.setAgentWorkspace(id, null))),
      open: payloadHandler(parseOpen, async (input) => {
        const current = await runCauseEffect(service.getAgentWorkspace(input.agentId));
        await openDirectory(
          input.location === "managed"
            ? current.managedPath
            : input.location === "shared"
              ? current.sharedPath
              : current.path,
        );
      }),
    },
  };
}
