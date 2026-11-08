import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  PROJECT_WORKSPACE_LIMITS,
  type ProjectGitInfo,
  type ProjectInstructionLocation,
  type ProjectSkillLocation,
  type ProjectWorkspace,
  type ProjectWorkspaceContext,
  type ProjectWorkspaceInfo,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

function invalid(): never {
  throw new Error("Invalid project workspace response.");
}
function text(value: unknown, limit: number = INPUT_LIMITS.path): string {
  if (typeof value !== "string" || !value || value.length > limit || /\p{Cc}/u.test(value)) return invalid();
  return value;
}
function scope(value: unknown): "project" | "ancestor" {
  return value === "project" || value === "ancestor" ? value : invalid();
}

function decodeProject(value: unknown): ProjectWorkspace {
  if (!isDynamicRecord(value)) return invalid();
  return { id: text(value.id, INPUT_LIMITS.identifier), name: text(value.name, 256), path: text(value.path) };
}
export function decodeProjectWorkspaces(value: unknown): ProjectWorkspace[] {
  if (!Array.isArray(value) || value.length > PROJECT_WORKSPACE_LIMITS.projects) return invalid();
  const projects = value.map(decodeProject);
  if (new Set(projects.map((project) => project.id)).size !== projects.length) return invalid();
  return projects;
}
function decodeGit(value: unknown): ProjectGitInfo {
  if (!isDynamicRecord(value)) return invalid();
  if (value.status === "none" || value.status === "unavailable") return { status: value.status };
  if (value.status !== "repository" || typeof value.worktree !== "boolean") return invalid();
  return {
    status: "repository",
    root: text(value.root),
    branch: value.branch === null ? null : text(value.branch),
    commit: value.commit === null ? null : text(value.commit, 64),
    worktree: value.worktree,
  };
}
function decodeInstruction(value: unknown): ProjectInstructionLocation {
  if (!isDynamicRecord(value)) return invalid();
  return { path: text(value.path), fileName: text(value.fileName, 256), scope: scope(value.scope) };
}
function decodeSkill(value: unknown): ProjectSkillLocation {
  if (!isDynamicRecord(value)) return invalid();
  return {
    path: text(value.path),
    slug: text(value.slug, 256),
    folder: text(value.folder, 256),
    scope: scope(value.scope),
  };
}
export function decodeProjectWorkspaceContext(value: unknown): ProjectWorkspaceContext {
  if (
    !isDynamicRecord(value) ||
    typeof value.available !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.instructions) ||
    value.instructions.length > PROJECT_WORKSPACE_LIMITS.instructions ||
    !Array.isArray(value.skills) ||
    value.skills.length > PROJECT_WORKSPACE_LIMITS.skills
  )
    return invalid();
  return {
    path: text(value.path),
    name: text(value.name, 256),
    available: value.available,
    git: decodeGit(value.git),
    instructions: value.instructions.map(decodeInstruction),
    skills: value.skills.map(decodeSkill),
    truncated: value.truncated,
  };
}
export function decodeProjectWorkspaceInfo(value: unknown): ProjectWorkspaceInfo {
  if (!isDynamicRecord(value)) return invalid();
  return { ...decodeProject(value), context: decodeProjectWorkspaceContext(value.context) };
}
export function decodeOptionalProjectWorkspaceInfo(value: unknown): ProjectWorkspaceInfo | null {
  return value === null ? null : decodeProjectWorkspaceInfo(value);
}
