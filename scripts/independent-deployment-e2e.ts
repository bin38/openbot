// Exercises real deployment entry points with no network, installation, or system service changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createOpenBotLogger } from "@openbot/logging";
import { macHostOperations, macHostReleaseSource } from "./host-manager-macos";

const logger = createOpenBotLogger("independent-deployment-e2e");
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "independent-deployment-"));
const output = resolve(".openbot-build/independent-deployment-e2e");
const installer = resolve("scripts/install-server.sh");
const updater = resolve("scripts/hosting/openbot-hosted-update");
const deniedCalls = join(temporary, "denied-calls");
const checks: string[] = [];
let passed = false;

async function bash(args: string[], repository = "") {
  return run("/bin/bash", args, {
    env: {
      PATH: `${join(temporary, "bin")}:/usr/bin:/bin`,
      OPENBOT_RELEASE_REPOSITORY: repository,
      OPENBOT_DEPLOYMENT_TEST_CALLS: deniedCalls,
    },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

const libraryOperation = [
  'source "$1"',
  'INSTALL="$2"',
  'SCRATCH="$2"',
  'LOCK="$2/lock"',
  'REQUESTS="$2/requests"',
  'STATE="$2/state"',
  'UNIT_DIRECTORY="$2/units"',
  'BOAT_PRE_STOP="$2/pre-stop"',
  '"$3" "$2/fixture-source" "$2/fixture-target"',
].join("\n");

try {
  const bin = join(temporary, "bin");
  await mkdir(bin);
  await writeFile(deniedCalls, "");
  for (const command of [
    "curl",
    "apt-get",
    "dpkg",
    "systemctl",
    "chown",
    "chmod",
    "cp",
    "rm",
    "mv",
    "install",
    "mktemp",
  ]) {
    await writeFile(
      join(bin, command),
      '#!/bin/bash\nprintf "%s\\n" "$0" >> "$OPENBOT_DEPLOYMENT_TEST_CALLS"\nexit 93\n',
      { mode: 0o700 },
    );
  }

  for (const repository of [
    "",
    "nightly-labs/openbot",
    "Nightly-Labs/OpenBot",
    "nightly-labs/openbot.git",
    "https://github.com/fixture-owner/openbot",
    "fixture-owner/repo?token=fixture",
    "fixture-owner/../openbot",
    "fixture-owner/repo/another",
  ]) {
    await assert.rejects(bash([installer, "--dry-run"], repository), /release repository|OPENBOT_RELEASE_REPOSITORY/);
    await assert.rejects(
      bash(["-c", libraryOperation, "deployment-fixture", updater, temporary, "stage"], repository),
      /release repository|OPENBOT_RELEASE_REPOSITORY/,
    );
    const environment = { OPENBOT_RELEASE_REPOSITORY: repository, OPENBOT_HOST_SIGNING_TEAM_ID: "AB12345678" };
    await assert.rejects(macHostOperations(environment).stageLatest(), /OPENBOT_RELEASE_REPOSITORY/);
    await assert.rejects(macHostOperations(environment).install("1.2.3"), /OPENBOT_RELEASE_REPOSITORY/);
  }
  checks.push("missing, invalid, and original repositories fail before network or install operations");

  for (const operation of [
    "apply",
    "request",
    "trigger",
    "swap_in",
    "install_packages",
    "prepare_release",
    "copy_release",
    "stage_release",
    "install_hosting",
  ]) {
    await assert.rejects(
      bash(["-c", libraryOperation, "deployment-fixture", updater, temporary, operation]),
      /OPENBOT_RELEASE_REPOSITORY/,
    );
  }
  checks.push("sourced Linux install and replacement operations also require an explicit source");

  await mkdir(join(temporary, "app"));
  await mkdir(join(temporary, "staged"));
  const sentinel = join(temporary, "app", "existing-content");
  await writeFile(sentinel, "keep existing content");
  await assert.rejects(
    bash(["-c", libraryOperation, "deployment-fixture", updater, temporary, "apply"], "fixture-owner/independent"),
    /no independent source record/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep existing content");
  checks.push("a staged release without source provenance cannot replace existing files");

  for (const script of [installer, updater]) {
    const help = await bash([script, "--help"]);
    assert.match(help.stdout, /OPENBOT_RELEASE_REPOSITORY/);
    const plan = await bash([script, "--dry-run"], "Fixture-Owner/Independent");
    assert.match(plan.stdout, /https:\/\/github\.com\/fixture-owner\/independent\/releases/);
    assert.doesNotMatch(plan.stdout, /nightly-labs|openbot\.run/);
  }
  const flagPlan = await bash([installer, "--release-repository", "fixture-owner/flag-source", "--dry-run"]);
  assert.match(flagPlan.stdout, /fixture-owner\/flag-source/);
  checks.push("help and dry-run work without root and show only the configured release source");

  const repository = "fixture-owner/independent";
  for (const signingTeam of [undefined, "", 'AB12345678" or true', "lowercase1"]) {
    const environment = { OPENBOT_RELEASE_REPOSITORY: repository, OPENBOT_HOST_SIGNING_TEAM_ID: signingTeam };
    await assert.rejects(macHostOperations(environment).stageLatest(), /OPENBOT_HOST_SIGNING_TEAM_ID/);
    await assert.rejects(macHostOperations(environment).install("1.2.3"), /OPENBOT_HOST_SIGNING_TEAM_ID/);
  }
  assert.deepEqual(
    macHostReleaseSource({
      OPENBOT_RELEASE_REPOSITORY: "Fixture-Owner/Independent",
      OPENBOT_HOST_SIGNING_TEAM_ID: "AB12345678",
    }),
    { repository, signingTeam: "AB12345678" },
  );
  checks.push("macOS requires a valid explicit signing identity before staging or replacement");
  assert.equal(await readFile(deniedCalls, "utf8"), "");
  passed = true;
} finally {
  await rm(temporary, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, externalNetworkUsed: false, deploymentRun: false }, null, 2)}\n`,
  );
}
logger.info("Independent deployment source checks passed.");
