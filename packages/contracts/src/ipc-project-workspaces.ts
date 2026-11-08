import type { CreateAgentInput } from "./ipc-agents";

export const PROJECT_WORKSPACE_LIMITS = { projects: 100, skills: 300, instructions: 128, depth: 64 } as const;

/** Local project metadata. These values do not extend the released Team API. */
export interface ProjectWorkspace {
  id: string;
  name: string;
  path: string;
}

export type ProjectGitInfo =
  | { status: "repository"; root: string; branch: string | null; commit: string | null; worktree: boolean }
  | { status: "none" | "unavailable" };

export interface ProjectInstructionLocation {
  path: string;
  fileName: string;
  scope: "project" | "ancestor";
}

export interface ProjectSkillLocation {
  slug: string;
  path: string;
  folder: string;
  scope: "project" | "ancestor";
}

/** Detection describes files. It does not install, enable or execute their instructions. */
export interface ProjectWorkspaceContext {
  path: string;
  name: string;
  available: boolean;
  git: ProjectGitInfo;
  instructions: ProjectInstructionLocation[];
  skills: ProjectSkillLocation[];
  truncated: boolean;
}

export interface ProjectWorkspaceInfo extends ProjectWorkspace {
  context: ProjectWorkspaceContext;
}

export interface CreateProjectAgentInput {
  projectId: string;
  input: CreateAgentInput;
}

export interface AssignProjectWorkspaceInput {
  projectId: string;
  agentId: string;
}
