// Exercises the actual dry-run CLI and preparation against temporary files; starts no services.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createOpenBotLogger } from "@openbot/logging";
import { developmentInstanceIdForWorktree, developmentUserDataName } from "../src/main/development-profile";
import {
  createDevelopmentServiceSpec,
  developmentEnvironmentForTarget,
  developmentInstanceIdForStart,
  developmentLaunchPlan,
  developmentProfileToSeed,
  hostingTestApiUrl,
  parseDevelopmentTarget,
} from "./dev-services";
import { prepareDevelopmentEnvironment, prepareLocalDevelopmentEnvironment } from "./prepare-dev-environment";

const logger = createOpenBotLogger("independent-dev-launch-e2e");
const run = promisify(execFile);
const output = resolve(".openbot-build/independent-dev-launch-e2e");
const root = await mkdtemp(join(tmpdir(), "independent-dev-launch-"));
const checks: string[] = [];
const cliPlans: Record<string, string[]> = {};
let passed = false;

async function cliPlan(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string[]> {
  const environment = { ...process.env, DOTENV_PRIVATE_KEY_DEV: "fixture-invalid-key-must-not-be-read", ...extra };
  const result = await run(process.execPath, [resolve("scripts/dev-services.ts"), ...args, "--dry-run"], {
    cwd: process.cwd(),
    env: environment,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return [
    ...`${result.stdout}\n${result.stderr}`.matchAll(/\[dev-services\] \[(api|remote|app|test-client)\] \[/gu),
  ].map((match) => match[1] ?? "");
}

try {
  const project = join(root, "worktree");
  const main = join(root, "main");
  await mkdir(join(project, ".openbot"), { recursive: true });
  await mkdir(main, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", workspaces: { packages: [] } }));
  await writeFile(join(project, "bun.lock"), "{}");
  await writeFile(join(project, "bunfig.toml"), "");
  await writeFile(join(project, ".worktreeinclude"), ".env.keys\n");
  await writeFile(join(main, ".env.keys"), "fixture-not-for-local-start");
  await writeFile(join(project, ".openbot", "dev-state.json"), "keep existing service state without parsing it");
  const profile = join(root, "existing-profile");
  await mkdir(profile);
  await writeFile(join(profile, "openbot.db"), "existing conversations");
  await writeFile(join(profile, "e2b-desktops.json"), "existing encrypted settings");
  const commands: string[][] = [];
  const preparation = {
    projectRoot: project,
    mainCheckoutRoot: main,
    bunVersion: "1.4.2",
    executable: "fixture-bun",
    run: (_executable: string, args: string[]) => {
      commands.push(args);
    },
  };
  prepareLocalDevelopmentEnvironment(preparation);
  prepareLocalDevelopmentEnvironment(preparation);
  assert.deepEqual(commands, [["install", "--frozen-lockfile"]]);
  assert.equal(existsSync(join(project, ".env.keys")), false);
  assert.equal(existsSync(join(project, "apps/auth-api/.wrangler")), false);
  assert.equal(
    await readFile(join(project, ".openbot/dev-state.json"), "utf8"),
    "keep existing service state without parsing it",
  );
  assert.equal(await readFile(join(profile, "openbot.db"), "utf8"), "existing conversations");
  assert.equal(await readFile(join(profile, "e2b-desktops.json"), "utf8"), "existing encrypted settings");
  checks.push(
    "local preparation installs dependencies once and neither copies service keys, migrates D1, seeds, nor edits profiles",
  );

  const invocation = parseDevelopmentTarget([]);
  const plan = developmentLaunchPlan(invocation);
  assert.deepEqual(plan, { services: ["app"], localDesktop: true, migrateAccountApi: false, seedProfile: false });
  const environment = developmentEnvironmentForTarget("app", {
    OPENBOT_DEV_INSTANCE_ID: "fixture-profile",
    OPENBOT_AUTH_API_URL: "https://api.openbot.run",
    OPENBOT_MOBILE_AUTH_API_URL: "https://api.openbot.run",
    OPENBOT_SELF_HOSTED_API_URL: "https://account.example.com",
    OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://signal.example.com/v1/signal",
    OPENBOT_REMOTE_SIGNAL_URL: "wss://signal.openbot.run/v1/signal",
    OPENBOT_DEV_REMOTE_ROLE: "host",
    OPENBOT_CODEX_PATH: "/fixture/codex",
  });
  assert.equal(environment.OPENBOT_DEV_REMOTE_ROLE, "none");
  assert.equal(environment.OPENBOT_AUTH_API_URL, undefined);
  assert.equal(environment.OPENBOT_MOBILE_AUTH_API_URL, undefined);
  assert.equal(environment.OPENBOT_REMOTE_SIGNAL_URL, undefined);
  assert.equal(environment.OPENBOT_SELF_HOSTED_API_URL, "https://account.example.com");
  assert.equal(environment.OPENBOT_SELF_HOSTED_SIGNAL_URL, "wss://signal.example.com/v1/signal");
  assert.equal(environment.OPENBOT_CODEX_PATH, "/fixture/codex");
  const spec = createDevelopmentServiceSpec("app", environment);
  assert.equal(spec.env.OPENBOT_DEV_INSTANCE_ID, "fixture-profile");
  assert.equal(
    developmentProfileToSeed([spec], () => false),
    null,
  );
  const id = developmentInstanceIdForStart({
    configured: undefined,
    shared: false,
    besideOwnStack: false,
    projectRoot: process.cwd(),
  });
  assert.equal(id, developmentInstanceIdForWorktree(process.cwd()));
  assert.equal(
    developmentUserDataName("app", id),
    developmentUserDataName("app", developmentInstanceIdForWorktree(process.cwd())),
  );
  checks.push(
    "the default plan contains only Electron/Vite, keeps the worktree profile identity and disables fake remote login",
  );

  const cases = [
    { args: [], expected: ["app"] },
    { args: ["app"], expected: ["app"] },
    { args: ["api"], expected: ["api"] },
    { args: ["remote"], expected: ["remote"] },
    { args: ["all"], expected: ["api", "remote", "app"] },
    { args: ["test-client"], expected: ["api", "remote", "app", "test-client"] },
    { args: ["app", "--with-services"], expected: ["api", "remote", "app"] },
    { args: ["app", "--slack"], expected: ["api", "remote", "app"] },
  ];
  for (const test of cases) {
    const services = await cliPlan(test.args);
    assert.deepEqual(services, test.expected);
    cliPlans[test.args.join(" ") || "default"] = services;
  }
  assert.equal(developmentLaunchPlan(parseDevelopmentTarget(["remote"])).migrateAccountApi, false);
  assert.equal(developmentLaunchPlan(parseDevelopmentTarget(["api"])).seedProfile, false);
  assert.equal(developmentLaunchPlan(parseDevelopmentTarget(["test-client"])).seedProfile, true);
  const testEnvironment = developmentEnvironmentForTarget("test-client", {}, false);
  assert.equal(createDevelopmentServiceSpec("app", testEnvironment).env.OPENBOT_DEV_REMOTE_ROLE, "host");
  assert.equal(createDevelopmentServiceSpec("test-client", testEnvironment).env.OPENBOT_DEV_REMOTE_ROLE, "client");
  checks.push(
    "actual CLI dry-runs preserve explicit API, Signal, all, test-client and integration stacks without launching them",
  );

  assert.throws(() => hostingTestApiUrl({}), /requires/);
  assert.throws(
    () => hostingTestApiUrl({ OPENBOT_HOSTING_TEST_API_URL: "https://openbot-auth-api-test.internal9671.workers.dev" }),
    /your own/,
  );
  assert.throws(() => hostingTestApiUrl({ OPENBOT_SELF_HOSTED_API_URL: "https://api.openbot.run" }), /your own/);
  const hosting = await cliPlan(["app", "--hosting=test"], { OPENBOT_HOSTING_TEST_API_URL: "http://127.0.0.1:31999" });
  assert.deepEqual(hosting, ["api", "remote", "app"]);
  cliPlans["own-hosting-test"] = hosting;
  checks.push("hosting tests require an explicit own endpoint and dry-run does not read developer credentials");

  // The explicit Signal preparation path can generate service identity without a D1 migration.
  const remoteProject = join(root, "remote-project");
  await mkdir(remoteProject, { recursive: true });
  await writeFile(
    join(remoteProject, "package.json"),
    JSON.stringify({ name: "remote-fixture", workspaces: { packages: [] } }),
  );
  await writeFile(join(remoteProject, "bun.lock"), "{}");
  await writeFile(join(remoteProject, "bunfig.toml"), "");
  const remoteCommands: string[][] = [];
  prepareDevelopmentEnvironment({
    projectRoot: remoteProject,
    mainCheckoutRoot: remoteProject,
    bunVersion: "1.4.2",
    migrateAccountApi: false,
    run: (_executable, args) => {
      remoteCommands.push(args);
    },
  });
  assert.deepEqual(remoteCommands, [["install", "--frozen-lockfile"]]);
  checks.push("explicit Signal-only preparation does not run Account API migrations");
  passed = true;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, cliPlans, servicesStarted: false }, null, 2)}\n`,
  );
}
logger.info("Independent development launch checks passed.");
