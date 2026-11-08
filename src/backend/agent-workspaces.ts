import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentSummary, AgentWorkspaceInfo } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { isPathInside } from "./path-containment";
import { isRecord } from "./protocol";
import { StoredStateFailure, storedIO } from "./stored-state-effects";

const bindingSchema = Schema.Struct({
  originalPath: Schema.String.check(
    Schema.isMaxLength(INPUT_LIMITS.path),
    Schema.makeFilter((path) => isAbsolute(path) && !path.includes("\0")),
  ),
});
export type AgentWorkspaceBinding = typeof bindingSchema.Type;
export const isAgentWorkspaceBinding = Schema.is(bindingSchema);
export type WorkspaceAgent = Pick<AgentSummary, "id" | "workspacePath"> & { workspaceBinding?: AgentWorkspaceBinding };

const canonicalOrMissing = Effect.fn("AgentWorkspaces.canonicalRoot")(function* (path: string) {
  return yield* storedIO(() => realpath(path)).pipe(
    Effect.catch((failure) =>
      isRecord(failure.cause) && (failure.cause.code === "ENOENT" || failure.cause.code === "ENOTDIR")
        ? Effect.succeed(resolve(path))
        : Effect.fail(failure),
    ),
  );
});

const requireSeparateWorkspace = Effect.fn("AgentWorkspaces.requireSeparate")(function* (
  selected: string,
  ownerId: string,
  agents: readonly WorkspaceAgent[],
) {
  for (const other of agents) {
    if (other.id === ownerId) continue;
    const otherPath = yield* canonicalOrMissing(other.workspacePath);
    // A project can be selected by several assistants. Managed folders remain private.
    if (other.workspaceBinding && otherPath === selected) continue;
    if (isPathInside(otherPath, selected) || isPathInside(selected, otherPath))
      return yield* new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceInUse")) });
  }
});

interface WorkspaceRoots {
  managed: string;
  legacy: string;
  shared: string;
  downloads: string;
  data: string;
}

const existingDirectory = Effect.fn("AgentWorkspaces.existingDirectory")(function* (path: string) {
  if (!isAbsolute(path) || path.length > INPUT_LIMITS.path || /\p{Cc}/u.test(path))
    return yield* new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceInvalid")) });
  const selected = yield* storedIO(() => realpath(path)).pipe(
    Effect.catch(() =>
      Effect.fail(new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceUnavailable")) })),
    ),
  );
  const metadata = yield* storedIO(() => lstat(selected));
  if (!metadata.isDirectory())
    return yield* new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceUnavailable")) });
  return selected;
});

/** Chooses existing workspaces without moving files or owning external directories. */
export class AgentWorkspacePaths {
  readonly #roots: WorkspaceRoots;
  constructor(roots: WorkspaceRoots) {
    this.#roots = roots;
  }

  original(agent: WorkspaceAgent): string {
    return agent.workspaceBinding?.originalPath ?? agent.workspacePath;
  }

  readonly project = Effect.fn("AgentWorkspaces.project")(function* (this: AgentWorkspacePaths, path: string) {
    const selected = yield* existingDirectory(path);
    yield* this.#requireProjectRoot(selected);
    return selected;
  }).bind(this);

  readonly #requireProjectRoot = Effect.fn("AgentWorkspaces.requireProjectRoot")(function* (
    this: AgentWorkspacePaths,
    selected: string,
  ) {
    for (const root of Object.values(this.#roots)) {
      const reserved = yield* canonicalOrMissing(root);
      if (isPathInside(reserved, selected) || isPathInside(selected, reserved))
        return yield* new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceReserved")) });
    }
  });

  readonly info = Effect.fn("AgentWorkspaces.info")(function* (this: AgentWorkspacePaths, agent: WorkspaceAgent) {
    const available = yield* storedIO(() => lstat(agent.workspacePath)).pipe(
      Effect.map((entry) => entry.isDirectory()),
      Effect.catch(() => Effect.succeed(false)),
    );
    return {
      agentId: agent.id,
      path: agent.workspacePath,
      managedPath: this.original(agent),
      sharedPath: this.#roots.shared,
      custom: agent.workspaceBinding !== undefined,
      available,
    } satisfies AgentWorkspaceInfo;
  }).bind(this);

  readonly ensure = Effect.fn("AgentWorkspaces.ensure")(function* (this: AgentWorkspacePaths, agent: WorkspaceAgent) {
    if (!agent.workspaceBinding) {
      yield* storedIO(() => mkdir(agent.workspacePath, { recursive: true, mode: 0o700 }));
      return;
    }
    const entry = yield* storedIO(() => lstat(agent.workspacePath)).pipe(
      Effect.catch(() =>
        Effect.fail(new StoredStateFailure({ cause: new Error(sourceText("error.agent.workspaceUnavailable")) })),
      ),
    );
    if (!entry.isDirectory())
      return yield* new StoredStateFailure({
        cause: new Error(sourceText("error.agent.workspaceUnavailable")),
      });
  }).bind(this);

  readonly select = Effect.fn("AgentWorkspaces.select")(function* (
    this: AgentWorkspacePaths,
    agent: WorkspaceAgent,
    agents: readonly WorkspaceAgent[],
    path: string | null,
  ) {
    if (path === null) {
      const originalPath = this.original(agent);
      yield* requireSeparateWorkspace(yield* canonicalOrMissing(originalPath), agent.id, agents);
      yield* storedIO(() => mkdir(originalPath, { recursive: true, mode: 0o700 }));
      return { path: originalPath, binding: undefined };
    }
    const selected = yield* existingDirectory(path);
    const original = yield* canonicalOrMissing(this.original(agent));
    if (selected === original) {
      yield* requireSeparateWorkspace(selected, agent.id, agents);
      return { path: this.original(agent), binding: undefined };
    }
    yield* this.#requireProjectRoot(selected);
    yield* requireSeparateWorkspace(selected, agent.id, agents);
    return { path: selected, binding: { originalPath: this.original(agent) } };
  }).bind(this);
}
