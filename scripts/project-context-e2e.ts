// Uses temporary projects and real local Git. No provider, remote or real instruction file is opened.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Fiber } from "effect";
import { projectWorkspaceSearchRoots, readProjectWorkspaceContext } from "../src/backend/project-context";

const logger = createOpenBotLogger("project-context-e2e");
const output = resolve(".openbot-build/project-context-e2e");
const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-project-context-")));
const git = promisify(execFile);
const checks: string[] = [];
const savedPath = process.env.PATH;
let passed = false;

async function file(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, text);
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (path: string, relative: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const key = join(relative, name);
      const entry = await lstat(child);
      if (entry.isSymbolicLink()) files[key] = `link:${await readlink(child)}`;
      else if (entry.isDirectory()) {
        files[key] = "directory";
        await walk(child, key);
      } else
        files[key] = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
    }
  };
  await walk(directory, "");
  return files;
}
async function inspectUnchanged(path: string, directory = root) {
  const before = await snapshot(directory);
  const result = await Effect.runPromise(readProjectWorkspaceContext(path));
  assert.deepEqual(await snapshot(directory), before, "Detection changes no project or Git file.");
  return result;
}
async function fakeGit(name: string, source: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory);
  await file(join(directory, "git"), `#!${process.execPath}\n${source}\n`);
  await chmod(join(directory, "git"), 0o700);
  return directory;
}
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  throw new Error("The fixture process did not start.");
}
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("The interrupted metadata process is still alive.");
}

try {
  const repository = join(root, "repository");
  const nested = join(repository, "packages", "example");
  const template = join(root, "empty-template");
  await mkdir(template);
  await git("git", ["init", "--quiet", "--initial-branch=main", `--template=${template}`, repository]);
  const unborn = await inspectUnchanged(repository);
  assert.equal(unborn.git.status, "repository");
  if (unborn.git.status !== "repository") throw new Error("Expected unborn repository metadata.");
  assert.equal(unborn.git.branch, "main");
  assert.equal(unborn.git.commit, null);
  checks.push("A real newly initialized repository has a branch and no commit, without changing Git files.");
  await mkdir(nested, { recursive: true });
  await file(join(root, "AGENTS.md"), "Outside repository fixture");
  await file(join(repository, "AGENTS.md"), "Root instructions fixture");
  await file(join(repository, "AGENTS.override.md"), "Override instructions fixture");
  await file(join(nested, "GEMINI.md"), "Nested instructions fixture");
  await file(join(repository, ".agents", "skills", "same", "SKILL.md"), "invalid frontmatter: metadata only");
  await file(join(nested, ".agents", "skills", "same", "SKILL.md"), "nearest skill fixture");
  await file(join(root, "linked-source", "SKILL.md"), "linked skill fixture");
  await symlink(join(root, "linked-source"), join(repository, ".agents", "skills", "linked"), "dir");
  await git("git", ["-C", repository, "add", "."]);
  await git("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    `-c`,
    `core.hooksPath=${template}`,
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ]);

  const context = await inspectUnchanged(nested);
  assert.equal(context.available, true);
  assert.equal(context.git.status, "repository");
  if (context.git.status !== "repository") throw new Error("Expected repository metadata.");
  assert.equal(context.git.root, repository);
  assert.equal(context.git.branch, "main");
  assert.match(context.git.commit ?? "", /^[\da-f]{40,64}$/u);
  assert.equal(context.git.worktree, false);
  assert.deepEqual(await Effect.runPromise(projectWorkspaceSearchRoots(nested)), [
    nested,
    join(repository, "packages"),
    repository,
  ]);
  assert.deepEqual(
    context.instructions.map((item) => item.path),
    [join(nested, "GEMINI.md"), join(repository, "AGENTS.override.md"), join(repository, "AGENTS.md")],
  );
  assert.equal(context.instructions[0]?.scope, "project");
  assert.equal(context.instructions[1]?.scope, "ancestor");
  assert.deepEqual(
    context.skills.filter((item) => item.slug === "same").map((item) => item.scope),
    ["project", "ancestor"],
  );
  assert(context.skills.some((item) => item.slug === "linked" && item.scope === "ancestor"));
  assert.equal(context.truncated, false);
  checks.push(
    "Real Git metadata and nearest-to-root instruction/skill filenames include symlinks and stop at the repository root, without changing files.",
  );

  const worktree = join(root, "linked-worktree");
  await git("git", ["-C", repository, "worktree", "add", "--quiet", "-b", "fixture-worktree", worktree]);
  const worktreeContext = await inspectUnchanged(worktree);
  assert.equal(worktreeContext.git.status, "repository");
  if (worktreeContext.git.status !== "repository") throw new Error("Expected worktree metadata.");
  assert.equal(worktreeContext.git.root, worktree);
  assert.equal(worktreeContext.git.branch, "fixture-worktree");
  assert.equal(worktreeContext.git.worktree, true);
  await git("git", ["-C", worktree, "checkout", "--quiet", "--detach"]);
  const detached = await inspectUnchanged(worktree);
  assert.equal(detached.git.status, "repository");
  if (detached.git.status !== "repository") throw new Error("Expected detached metadata.");
  assert.equal(detached.git.branch, null);
  assert(detached.git.commit);
  checks.push("A real Git worktree file and detached HEAD retain the correct root, commit and worktree state.");

  const plain = join(root, "plain");
  await mkdir(plain);
  await file(join(plain, "CLAUDE.md"), "Plain instructions fixture");
  const plainContext = await inspectUnchanged(plain);
  assert.equal(plainContext.git.status, "none");
  assert.equal(plainContext.available, true);
  assert.deepEqual(
    plainContext.instructions.map((item) => item.path),
    [join(plain, "CLAUDE.md")],
  );
  assert.deepEqual(await Effect.runPromise(projectWorkspaceSearchRoots(plain)), [plain]);
  const missing = await inspectUnchanged(join(root, "missing"));
  assert.equal(missing.available, false);
  assert.deepEqual(missing.instructions, []);
  assert.deepEqual(missing.skills, []);
  assert.deepEqual(await Effect.runPromise(projectWorkspaceSearchRoots(join(root, "missing"))), []);
  checks.push(
    "Plain folders remain useful and missing folders stay unavailable; neither scans unrelated ancestors or creates directories.",
  );

  process.env.PATH = join(root, "missing-git");
  const unavailable = await inspectUnchanged(nested);
  assert.equal(unavailable.git.status, "unavailable");
  assert.equal(unavailable.available, true);
  assert.deepEqual(await Effect.runPromise(projectWorkspaceSearchRoots(nested)), [nested]);
  process.env.PATH = savedPath;
  const untrustedBin = await fakeGit(
    "untrusted-git",
    "process.stderr.write('fatal: detected dubious ownership in repository'); process.exit(128);",
  );
  process.env.PATH = `${untrustedBin}${delimiter}${savedPath ?? ""}`;
  assert.equal((await inspectUnchanged(nested)).git.status, "unavailable");
  process.env.PATH = savedPath;
  checks.push(
    "Missing Git and a refused repository produce unavailable metadata without bypassing Git trust or scanning parents.",
  );

  const excessiveBin = await fakeGit("excessive-git", "process.stdout.write('x'.repeat(100000));");
  process.env.PATH = `${excessiveBin}${delimiter}${savedPath ?? ""}`;
  assert.equal((await inspectUnchanged(nested)).git.status, "unavailable");
  process.env.PATH = savedPath;
  checks.push("Excessive Git output is bounded and produces unavailable metadata.");

  const marker = join(root, "git-started");
  const hangingBin = await fakeGit(
    "hanging-git",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  process.env.PATH = `${hangingBin}${delimiter}${savedPath ?? ""}`;
  const fiber = Effect.runFork(readProjectWorkspaceContext(nested));
  const pid = Number(await waitForFile(marker));
  assert(Number.isSafeInteger(pid));
  await Effect.runPromise(Fiber.interrupt(fiber));
  await waitForExit(pid);
  assert.equal((await inspectUnchanged(nested, repository)).git.status, "unavailable");
  process.env.PATH = savedPath;
  checks.push("Cancellation kills the owned Git process and a Git deadline returns unavailable metadata.");

  const crowded = join(root, "crowded");
  for (let index = 0; index < 305; index += 1)
    await file(join(crowded, ".agents", "skills", `skill-${index}`, "SKILL.md"), "fixture");
  const bounded = await inspectUnchanged(crowded);
  assert.equal(bounded.skills.length, 300);
  assert.equal(bounded.truncated, true);
  checks.push("Skill filename discovery has a fixed result bound and marks truncated results.");
  passed = true;
} finally {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, liveProviderUsed: false }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
  logger.info("Project metadata checks finished.", { passed, checks: checks.length });
}
