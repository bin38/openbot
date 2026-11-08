import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { PROJECT_WORKSPACE_LIMITS, type ProjectWorkspace, type ProjectWorkspaceInfo } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Option, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { readProjectWorkspaceContext } from "../backend/project-context";
import type { StoredStateFailure } from "../backend/stored-state-effects";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";

export const PROJECT_WORKSPACES_FILE = "openbot-project-workspaces-v1.json";

const savedProject = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(INPUT_LIMITS.identifier)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  path: Schema.String.check(
    Schema.isMaxLength(INPUT_LIMITS.path),
    Schema.makeFilter((value) => isAbsolute(value) && !/\p{Cc}/u.test(value)),
  ),
});
const savedProjects = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(savedProject).check(Schema.isMaxLength(PROJECT_WORKSPACE_LIMITS.projects)),
});

export class ProjectWorkspaceFailure extends Schema.TaggedError<ProjectWorkspaceFailure>()("ProjectWorkspaceFailure", {
  message: Schema.String,
}) {}

/** Remembers local project choices. Project contents and Git state are never written here. */
export class ProjectWorkspaces {
  #projects: ProjectWorkspace[] = [];
  #unreadable = false;
  readonly #writes = Semaphore.makeUnsafe(1);

  constructor(
    private readonly options: {
      path: string;
      validateDirectory: (path: string) => Effect.Effect<string, StoredStateFailure>;
    },
  ) {}

  readonly load = Effect.fn("ProjectWorkspaces.load")(function* (this: ProjectWorkspaces) {
    const result = yield* Effect.result(
      readPreferenceFile(this.options.path, Schema.decodeUnknownOption(savedProjects, { onExcessProperty: "error" })),
    );
    if (Result.isFailure(result)) {
      this.#unreadable = !isMissingFileError(result.failure.cause);
      return;
    }
    if (Option.isNone(result.success)) {
      this.#unreadable = true;
      return;
    }
    const projects = result.success.value.projects;
    if (
      new Set(projects.map((project) => project.id)).size !== projects.length ||
      new Set(projects.map((project) => project.path)).size !== projects.length
    ) {
      this.#unreadable = true;
      return;
    }
    this.#projects = projects.map((project) => ({ ...project }));
  }).bind(this);

  #requireReadable(): void {
    if (this.#unreadable)
      throw new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectListUnreadable") });
  }

  list(): ProjectWorkspace[] {
    this.#requireReadable();
    return this.#projects.map((project) => ({ ...project }));
  }

  #find(id: string): ProjectWorkspace {
    this.#requireReadable();
    const project = this.#projects.find((item) => item.id === id);
    if (!project) throw new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectUnknown") });
    return project;
  }

  readonly inspect = Effect.fn("ProjectWorkspaces.inspect")(function* (this: ProjectWorkspaces, id: string) {
    const project = yield* Effect.try({ try: () => this.#find(id), catch: toProjectFailure });
    const context = yield* this.inspectPath(project.path);
    return { ...project, context } satisfies ProjectWorkspaceInfo;
  }).bind(this);

  inspectPath(path: string) {
    return readProjectWorkspaceContext(path).pipe(
      Effect.mapError(() => new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectInspectFailed") })),
    );
  }

  readonly resolve = Effect.fn("ProjectWorkspaces.resolve")(function* (this: ProjectWorkspaces, id: string) {
    const project = yield* Effect.try({ try: () => this.#find(id), catch: toProjectFailure });
    const canonical = yield* this.options
      .validateDirectory(project.path)
      .pipe(
        Effect.mapError(() => new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectUnavailable") })),
      );
    if (canonical !== project.path)
      return yield* new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectUnavailable") });
    return canonical;
  }).bind(this);

  readonly remember = Effect.fn("ProjectWorkspaces.remember")(function* (this: ProjectWorkspaces, path: string) {
    const canonical = yield* this.options
      .validateDirectory(path)
      .pipe(
        Effect.mapError(() => new ProjectWorkspaceFailure({ message: sourceText("error.agent.workspaceInvalid") })),
      );
    const project = yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.try({ try: () => this.#requireReadable(), catch: toProjectFailure });
        const existing = this.#projects.find((item) => item.path === canonical);
        if (existing) return existing;
        if (this.#projects.length >= PROJECT_WORKSPACE_LIMITS.projects)
          return yield* new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectListFull") });
        const next = { id: randomUUID(), name: basename(canonical) || canonical, path: canonical };
        yield* this.#save([next, ...this.#projects]);
        return next;
      }).pipe(Effect.uninterruptible),
    );
    return yield* this.inspect(project.id);
  }).bind(this);

  readonly forget = Effect.fn("ProjectWorkspaces.forget")(function* (this: ProjectWorkspaces, id: string) {
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.try({ try: () => this.#requireReadable(), catch: toProjectFailure });
        if (!this.#projects.some((project) => project.id === id)) return;
        yield* this.#save(this.#projects.filter((project) => project.id !== id));
      }).pipe(Effect.uninterruptible),
    );
  }).bind(this);

  #save(projects: ProjectWorkspace[]): Effect.Effect<void, ProjectWorkspaceFailure> {
    return writePreferenceFile(this.options.path, { version: 1, projects }).pipe(
      Effect.mapError(() => new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectSaveFailed") })),
      Effect.tap(() =>
        Effect.sync(() => {
          this.#projects = projects;
        }),
      ),
    );
  }
}

function toProjectFailure(error: unknown): ProjectWorkspaceFailure {
  return error instanceof ProjectWorkspaceFailure
    ? error
    : new ProjectWorkspaceFailure({ message: sourceText("error.agent.projectInspectFailed") });
}
