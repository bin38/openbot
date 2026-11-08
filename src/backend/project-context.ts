import { execFile } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AGENT_PROVIDER_DESCRIPTORS } from "@openbot/contracts/agent-providers";
import { PROJECT_WORKSPACE_LIMITS, type ProjectGitInfo, type ProjectWorkspaceContext } from "@openbot/contracts/ipc";
import { Effect, Schema } from "effect";
import { isPathInside } from "./path-containment";

/** Native failures stay private; callers map this error at their application boundary. */
class ProjectContextFailure extends Schema.TaggedError<ProjectContextFailure>()("ProjectContextFailure", {
  cause: Schema.Defect(),
}) {}

const inspectIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ProjectContextFailure({ cause }) });
const instructionNames = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
const skillFolders = [...new Set(AGENT_PROVIDER_DESCRIPTORS.flatMap((provider) => provider.skillFolders))];
const GIT_OUTPUT_BYTES = 32 * 1024;
const GIT_TIMEOUT_MS = 3_000;

interface GitAnswer {
  code: number | null;
  text: string;
  notRepository: boolean;
}

/** Fixed metadata operations only: no shell, hooks, filters, index writes, remotes or network. */
const gitRead = Effect.fn("ProjectContext.gitRead")(function* (cwd: string, args: readonly string[]) {
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<GitAnswer>((complete) => {
        const environment = { ...process.env };
        // A parent process can select another repository or inject command configuration through these.
        for (const name of Object.keys(environment)) if (name.startsWith("GIT_")) delete environment[name];
        environment.GIT_OPTIONAL_LOCKS = "0";
        environment.GIT_TERMINAL_PROMPT = "0";
        environment.LC_ALL = "C";
        execFile(
          "git",
          ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
          {
            cwd,
            env: environment,
            encoding: "utf8",
            maxBuffer: GIT_OUTPUT_BYTES,
            timeout: GIT_TIMEOUT_MS,
            killSignal: "SIGKILL",
            signal,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            complete({
              code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
              text: error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "" : stdout,
              notRepository: stderr.includes("not a git repository"),
            });
          },
        );
      }),
    catch: (cause) => new ProjectContextFailure({ cause }),
  });
});

function outputLine(text: string): string | null {
  const value = text.replace(/\r?\n$/u, "");
  return value && !/[\r\n\0]/u.test(value) ? value : null;
}

const repositoryRoot = Effect.fn("ProjectContext.repositoryRoot")(function* (cwd: string) {
  const answer = yield* gitRead(cwd, ["rev-parse", "--show-toplevel"]);
  if (answer.code !== 0) return { status: answer.notRepository ? "none" : "unavailable" } as const;
  const path = outputLine(answer.text);
  if (!path || !isAbsolute(path)) return { status: "unavailable" } as const;
  const root = yield* inspectIo(() => realpath(path)).pipe(Effect.orElseSucceed(() => null));
  return root && isPathInside(root, cwd)
    ? ({ status: "repository", root } as const)
    : ({ status: "unavailable" } as const);
});

const availableRoot = Effect.fn("ProjectContext.availableRoot")(function* (path: string) {
  const root = yield* inspectIo(() => realpath(path));
  return (yield* inspectIo(() => stat(root))).isDirectory() ? root : null;
});

function searchRoots(cwd: string, root: string): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let current = cwd;
  for (let depth = 0; depth < PROJECT_WORKSPACE_LIMITS.depth; depth += 1) {
    paths.push(current);
    if (current === root) return { paths, truncated: false };
    const parent = dirname(current);
    if (parent === current || !isPathInside(root, parent)) return { paths, truncated: true };
    current = parent;
  }
  return { paths, truncated: true };
}

/** Search nearest workspace first, through its Git root; plain or unavailable repositories stay local. */
export const projectWorkspaceSearchRoots = Effect.fn("ProjectContext.searchRoots")(function* (path: string) {
  const cwd = yield* availableRoot(path).pipe(Effect.orElseSucceed(() => null));
  if (!cwd) return [];
  const git = yield* repositoryRoot(cwd);
  return searchRoots(cwd, git.status === "repository" ? git.root : cwd).paths;
});

const gitInfo = Effect.fn("ProjectContext.gitInfo")(function* (cwd: string, root: string) {
  const branch = yield* gitRead(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 && branch.code !== 1) return { status: "unavailable" } as const;
  const commit = yield* gitRead(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (commit.code !== 0 && commit.code !== 128) return { status: "unavailable" } as const;
  const directories = yield* gitRead(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  const lines = directories.text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const [gitDirectory, commonDirectory] = lines;
  const branchName = outputLine(branch.text);
  const commitId = outputLine(commit.text);
  if (
    directories.code !== 0 ||
    lines.length !== 2 ||
    !gitDirectory ||
    !commonDirectory ||
    (branch.code === 0 && !branchName) ||
    (commit.code === 0 && (!commitId || !/^[\da-f]{40,64}$/u.test(commitId)))
  )
    return { status: "unavailable" } as const;
  return {
    status: "repository",
    root,
    branch: branch.code === 0 ? branchName : null,
    commit: commit.code === 0 ? commitId : null,
    worktree: resolve(cwd, gitDirectory) !== resolve(cwd, commonDirectory),
  } satisfies ProjectGitInfo;
});

const isFile = (path: string) =>
  inspectIo(() => stat(path)).pipe(
    Effect.map((entry) => entry.isFile()),
    Effect.orElseSucceed(() => false),
  );

/** Bounded directory discovery; following a skill symlink does not read or execute its instructions. */
const skillNames = Effect.fn("ProjectContext.skillNames")(function* (path: string, limit: number) {
  return yield* inspectIo(async () => {
    const directory = await opendir(path);
    const names: string[] = [];
    let truncated = false;
    try {
      for await (const entry of directory) {
        if (entry.name.startsWith(".") || entry.name.includes(".openbot-")) continue;
        if (names.length >= limit) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      // Async iteration closes the handle on completion and early return.
      await directory.close().catch(() => undefined);
    }
    return { names: names.sort(), truncated };
  }).pipe(Effect.orElseSucceed(() => ({ names: [], truncated: false })));
});

/** Detects project files without reading instruction or skill bodies and without changing the project. */
export const readProjectWorkspaceContext = Effect.fn("ProjectContext.read")(function* (path: string) {
  const cwd = yield* availableRoot(path).pipe(Effect.orElseSucceed(() => null));
  const context: ProjectWorkspaceContext = {
    path: cwd ?? resolve(path),
    name: basename(cwd ?? resolve(path)),
    available: cwd !== null,
    git: { status: "none" },
    instructions: [],
    skills: [],
    truncated: false,
  };
  if (!cwd) return context;
  const git = yield* repositoryRoot(cwd);
  context.git = git.status === "repository" ? yield* gitInfo(cwd, git.root) : git;
  const roots = searchRoots(cwd, git.status === "repository" ? git.root : cwd);
  context.truncated = roots.truncated;
  for (const root of roots.paths) {
    const scope = root === cwd ? "project" : "ancestor";
    for (const fileName of instructionNames) {
      const candidate = join(root, fileName);
      if (!(yield* isFile(candidate))) continue;
      if (context.instructions.length >= PROJECT_WORKSPACE_LIMITS.instructions) {
        context.truncated = true;
        continue;
      }
      context.instructions.push({ path: candidate, fileName, scope });
    }
    for (const folder of skillFolders) {
      const remaining = PROJECT_WORKSPACE_LIMITS.skills - context.skills.length;
      const found = yield* skillNames(join(root, folder), remaining + 1);
      context.truncated ||= found.truncated;
      for (const slug of found.names) {
        const candidate = join(root, folder, slug, "SKILL.md");
        if (!(yield* isFile(candidate))) continue;
        if (context.skills.length >= PROJECT_WORKSPACE_LIMITS.skills) {
          context.truncated = true;
          continue;
        }
        context.skills.push({ slug, path: candidate, folder, scope });
      }
    }
  }
  return context;
});
