import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AssignProjectWorkspaceInput, CreateProjectAgentInput } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result } from "effect";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostService } from "../host-service";
import type { ProjectWorkspaceFailure, ProjectWorkspaces } from "../project-workspaces";
import { parseCreateAgent } from "./agent-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString, stringPayload } from "./validation";

const projectId = stringPayload("Project id", INPUT_LIMITS.identifier);

function parseCreate(value: unknown): CreateProjectAgentInput {
  if (!isDynamicRecord(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "input"))
    throw new Error("Invalid project creation request.");
  return { projectId: projectId(value.projectId), input: parseCreateAgent(value.input) };
}

function parseAssign(value: unknown): AssignProjectWorkspaceInput {
  if (!isDynamicRecord(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "agentId"))
    throw new Error("Invalid project assignment request.");
  return {
    projectId: projectId(value.projectId),
    agentId: requireString(value.agentId, "Agent id", INPUT_LIMITS.identifier),
  };
}

export async function runProjectWorkspace<A>(operation: Effect.Effect<A, ProjectWorkspaceFailure>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

/** The native picker is the only path input. Remote peers cannot choose local project folders. */
export function projectWorkspacesIpcHandlers(dependencies: {
  projects: Pick<ProjectWorkspaces, "list" | "remember" | "inspect" | "resolve" | "forget">;
  service: Pick<AgentService, "createAgent" | "setAgentWorkspace">;
  chooseDirectory: () => Promise<string | null>;
  conversationSender: HostService["conversationSender"];
}): Pick<IpcGroupHandlers, "projectWorkspaces"> {
  const { projects, service, chooseDirectory, conversationSender } = dependencies;
  return {
    projectWorkspaces: {
      list: handler(() => projects.list()),
      choose: handler(async () => {
        const path = await chooseDirectory();
        return path === null ? null : runProjectWorkspace(projects.remember(path));
      }),
      inspect: payloadHandler(projectId, (id) => runProjectWorkspace(projects.inspect(id))),
      forget: payloadHandler(projectId, (id) => runProjectWorkspace(projects.forget(id))),
      create: payloadHandler(parseCreate, async ({ projectId: id, input }) => {
        const path = await runProjectWorkspace(projects.resolve(id));
        return runCauseEffect(service.createAgent(input, undefined, undefined, conversationSender(), path));
      }),
      assign: payloadHandler(parseAssign, async ({ projectId: id, agentId }) => {
        const path = await runProjectWorkspace(projects.resolve(id));
        return runCauseEffect(service.setAgentWorkspace(agentId, path));
      }),
    },
  };
}
