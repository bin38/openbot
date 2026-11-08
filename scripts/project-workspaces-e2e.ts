// Real project registry, AgentStore, Git and filesystem checks; no user project or Skill is opened.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { ProjectWorkspaces } from "../src/main/project-workspaces";

const logger = createOpenBotLogger("project-workspaces-e2e");
const exec = promisify(execFile);
const output = resolve(".openbot-build/project-workspaces-e2e");
const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-project-registry-")));
const profile = join(root, "profile");
const files = join(root, "files");
const project = join(root, "projects", "Fixture project");
const linked = join(root, "projects", "Linked worktree");
const registryPath = join(profile, "projects.json");
let database: OpenBotDatabase | null = null;
const checks: string[] = [];
let passed = false;

async function git(args: string[]): Promise<void> {
  await exec("git", args, {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 10_000,
  });
}

try {
  await mkdir(project, { recursive: true });
  await mkdir(files, { recursive: true });
  await mkdir(join(project, ".agents", "skills", "fixture-metadata"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "Synthetic fixture instructions. Do not modify fixture files.\n");
  const skillMarker = join(project, ".agents", "skills", "fixture-metadata", "SKILL.md");
  await writeFile(skillMarker, "");
  await writeFile(join(project, "sentinel.txt"), "retained-project-data");
  const skillBefore = await stat(skillMarker, { bigint: true });
  const instructionsBefore = await readFile(join(project, "AGENTS.md"), "utf8");
  await git(["init", "--quiet", "--initial-branch=fixture-main", project]);
  await git([
    "-C",
    project,
    "-c",
    "user.name=OpenBot Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Synthetic project root",
  ]);
  await git(["-C", project, "worktree", "add", "--quiet", "-b", "fixture-linked", linked]);

  database = new OpenBotDatabase(profile);
  const store = new AgentStore(profile, files, database);
  await runCauseEffect(store.initialize());
  const options = { path: registryPath, validateDirectory: (path: string) => store.validateProjectWorkspace(path) };
  const registry = new ProjectWorkspaces(options);
  await Effect.runPromise(registry.load());
  assert.deepEqual(registry.list(), []);
  const remembered = await Effect.runPromise(registry.remember(project));
  assert.equal(remembered.name, "Fixture project");
  assert.equal(remembered.path, project);
  assert.equal(remembered.context.path, project);
  assert.equal(remembered.context.git.status, "repository");
  if (remembered.context.git.status === "repository") {
    assert.equal(remembered.context.git.root, project);
    assert.equal(remembered.context.git.branch, "fixture-main");
    assert.match(remembered.context.git.commit ?? "", /^[a-f0-9]{40}$/u);
    assert.equal(remembered.context.git.worktree, false);
  }
  assert.ok(
    remembered.context.instructions.some(
      (item) => item.fileName === "AGENTS.md" && item.path === join(project, "AGENTS.md"),
    ),
  );
  assert.ok(remembered.context.skills.some((item) => item.slug === "fixture-metadata"));
  const alias = join(root, "project-alias");
  await symlink(project, alias, "dir");
  assert.equal((await Effect.runPromise(registry.remember(alias))).id, remembered.id);
  assert.equal(registry.list().length, 1);
  assert.equal(await Effect.runPromise(registry.resolve(remembered.id)), project);
  checks.push(
    "A canonical project is remembered once, including a symlink alias; real Git and instruction/skill-location metadata are read without opening Skill content.",
  );

  const linkedProject = await Effect.runPromise(registry.remember(linked));
  assert.equal(linkedProject.context.git.status, "repository");
  if (linkedProject.context.git.status === "repository") {
    assert.equal(linkedProject.context.git.root, linked);
    assert.equal(linkedProject.context.git.branch, "fixture-linked");
    assert.equal(linkedProject.context.git.worktree, true);
  }
  const reopened = new ProjectWorkspaces(options);
  await Effect.runPromise(reopened.load());
  assert.deepEqual(reopened.list(), registry.list());
  assert.equal(await Effect.runPromise(reopened.resolve(remembered.id)), project);
  assert.equal((await Effect.runPromise(reopened.inspect(linkedProject.id))).context.git.status, "repository");
  checks.push(
    "Named projects and a real linked worktree survive registry reload and remain resolvable by their opaque IDs.",
  );

  const missing = join(root, "projects", "missing");
  await assert.rejects(Effect.runPromise(reopened.remember(missing)));
  for (const invalid of ["../outside", `${project}\0outside`, `${project}\nother`, profile, root])
    await assert.rejects(Effect.runPromise(reopened.remember(invalid)));
  const unchanged = await readFile(registryPath, "utf8");
  await assert.rejects(Effect.runPromise(reopened.resolve("../../outside")));
  await assert.rejects(Effect.runPromise(reopened.inspect("../../outside")));
  await Effect.runPromise(reopened.forget("../../outside"));
  assert.equal(await readFile(registryPath, "utf8"), unchanged);
  assert.equal(await readFile(join(project, "sentinel.txt"), "utf8"), "retained-project-data");
  checks.push(
    "Missing, relative, control-character and reserved paths are refused; an unrecognized ID cannot act as a filesystem path.",
  );

  const moved = join(root, "projects", "Moved original");
  const replacement = join(root, "projects", "Replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, "sentinel.txt"), "replacement-data");
  await rename(project, moved);
  assert.equal((await Effect.runPromise(reopened.inspect(remembered.id))).context.available, false);
  await assert.rejects(Effect.runPromise(reopened.resolve(remembered.id)));
  await symlink(replacement, project, "dir");
  await assert.rejects(Effect.runPromise(reopened.resolve(remembered.id)));
  await Effect.runPromise(reopened.forget(remembered.id));
  assert.equal(
    reopened.list().some((item) => item.id === remembered.id),
    false,
  );
  assert.equal(await readFile(join(moved, "sentinel.txt"), "utf8"), "retained-project-data");
  assert.equal(await readFile(join(replacement, "sentinel.txt"), "utf8"), "replacement-data");
  assert.equal(await readFile(join(moved, "AGENTS.md"), "utf8"), instructionsBefore);
  const skillAfter = await stat(join(moved, ".agents", "skills", "fixture-metadata", "SKILL.md"), { bigint: true });
  assert.equal(skillAfter.size, skillBefore.size);
  assert.equal(skillAfter.mtimeNs, skillBefore.mtimeNs);
  checks.push(
    "A missing or retargeted remembered path cannot be assigned; forgetting it leaves project files and instruction/Skill metadata untouched.",
  );

  const valid = { id: "fixture-project", name: "Fixture", path: replacement };
  const invalidFiles = [
    "not-json",
    JSON.stringify({ version: 2, projects: [valid] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, path: "../outside" }] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, path: `${replacement}\0outside` }] }),
    JSON.stringify({ version: 1, projects: [valid, { ...valid, path: moved }] }),
    JSON.stringify({ version: 1, projects: [valid, { ...valid, id: "different-id" }] }),
    JSON.stringify({ version: 1, projects: [valid], futureField: "retained" }),
  ];
  for (const [index, text] of invalidFiles.entries()) {
    const path = join(profile, `invalid-projects-${index}.json`);
    await writeFile(path, text);
    const blocked = new ProjectWorkspaces({ ...options, path });
    await Effect.runPromise(blocked.load());
    assert.throws(() => blocked.list());
    await assert.rejects(Effect.runPromise(blocked.remember(replacement)));
    await assert.rejects(Effect.runPromise(blocked.forget(valid.id)));
    assert.equal(await readFile(path, "utf8"), text);
  }
  checks.push(
    "Malformed, future, duplicate and injected registry records remain read-only and are not overwritten by remember or forget.",
  );
  passed = true;
} finally {
  database?.close();
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, liveProviderUsed: false, realSkillContentRead: false }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
  logger.info("Project workspace registry checks finished.", { passed, checks: checks.length });
  if (!passed) process.exitCode = 1;
}
