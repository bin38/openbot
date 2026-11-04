// Drives the packaged-installation service against real temporary resource files.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { buildContentSecurityPolicy, configuredSelfHostedSignalOrigin } from "../src/main/content-security-policy";
import {
  INDEPENDENT_SERVICES_FILE,
  INDEPENDENT_USER_DATA_NAME,
  type IndependentInstallationOptions,
  readIndependentInstallation,
} from "../src/main/independent-installation";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(projectRoot, ".openbot-build/independent-installation-e2e");
const logger = createOpenBotLogger("independent-installation-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-independent-installation-"));
const resourcesPath = join(root, "resources");
const resourcePath = join(resourcesPath, INDEPENDENT_SERVICES_FILE);
const appDataPath = join(root, "app-data");
const originalProfile = join(appDataPath, "OpenBot");
const retainedFile = join(originalProfile, "retained.json");
const fixture = {
  version: 1,
  accountUrl: "https://account.example.com",
  signalUrl: "wss://signal.example.com/v1/signal",
};
const checks: string[] = [];
let passed = false;

function options(overrides: Partial<IndependentInstallationOptions> = {}): IndependentInstallationOptions {
  return {
    packaged: true,
    independent: true,
    rootDesktop: true,
    resourcesPath,
    appDataPath,
    userDataOverride: "",
    environment: {},
    ...overrides,
  };
}

try {
  await mkdir(resourcesPath, { recursive: true });
  await mkdir(originalProfile, { recursive: true });
  await writeFile(retainedFile, "retained user data\n");
  await writeFile(resourcePath, JSON.stringify(fixture));
  const installation = await Effect.runPromise(readIndependentInstallation(options()));
  assert.ok(installation);
  assert.equal(installation.userDataPath, join(appDataPath, INDEPENDENT_USER_DATA_NAME));
  assert.equal(installation.accountUrl, fixture.accountUrl);
  assert.equal(installation.signalUrl, fixture.signalUrl);
  assert.equal(await readFile(retainedFile, "utf8"), "retained user data\n");
  checks.push("Packaged defaults select a separate profile and own services without changing the existing profile.");

  const explicit = await Effect.runPromise(
    readIndependentInstallation(
      options({
        userDataOverride: join(root, "explicit-profile"),
        environment: {
          OPENBOT_SELF_HOSTED_API_URL: "https://override.example.com/",
          OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://override-signal.example.com:8443/v1/signal",
          OPENBOT_AUTH_API_URL: "https://api.openbot.run",
          OPENBOT_REMOTE_SIGNAL_URL: "wss://signal.openbot.run/v1/signal",
        },
      }),
    ),
  );
  assert.ok(explicit);
  assert.equal(explicit.userDataPath, join(root, "explicit-profile"));
  assert.equal(explicit.accountUrl, "https://override.example.com");
  assert.equal(explicit.signalUrl, "wss://override-signal.example.com:8443/v1/signal");
  const connect = buildContentSecurityPolicy(
    true,
    undefined,
    configuredSelfHostedSignalOrigin(
      {
        OPENBOT_SELF_HOSTED_API_URL: explicit.accountUrl ?? undefined,
        OPENBOT_SELF_HOSTED_SIGNAL_URL: explicit.signalUrl ?? undefined,
      },
      true,
    ),
  )
    .split("; ")
    .find((directive) => directive.startsWith("connect-src "));
  assert.ok(connect?.includes(" wss://override-signal.example.com:8443"));
  assert.ok(!connect?.includes("openbot.run"));
  assert.ok(!connect?.includes("wss://signal.example.com"));
  assert.ok(!connect?.split(" ").includes("wss:"));
  checks.push(
    "Explicit own configuration wins; CSP admits only the selected Signal origin and never legacy vendor settings.",
  );

  for (const environment of [
    { OPENBOT_SELF_HOSTED_API_URL: "https://api.openbot.run" },
    { OPENBOT_SELF_HOSTED_API_URL: "https://account.example.com/?token=fixture" },
    { OPENBOT_SELF_HOSTED_API_URL: "http://account.example.com" },
    { OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://user:fixture@signal.example.com/v1/signal" },
    { OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://signal.openbot.run./v1/signal" },
  ]) {
    await assert.rejects(Effect.runPromise(readIndependentInstallation(options({ environment }))));
  }
  const loopback = await Effect.runPromise(
    readIndependentInstallation(
      options({
        environment: { OPENBOT_SELF_HOSTED_API_URL: "http://127.0.0.1:3100", OPENBOT_SELF_HOSTED_SIGNAL_URL: "" },
      }),
    ),
  );
  assert.equal(loopback?.accountUrl, "http://127.0.0.1:3100");
  assert.equal(loopback?.signalUrl, null);
  checks.push("Explicit settings keep existing loopback support but cannot bypass origin or credential validation.");

  const disabled = await Effect.runPromise(
    readIndependentInstallation(
      options({
        environment: { OPENBOT_SELF_HOSTED_API_URL: "", OPENBOT_SELF_HOSTED_SIGNAL_URL: "" },
      }),
    ),
  );
  assert.equal(disabled?.accountUrl, null);
  assert.equal(disabled?.signalUrl, null);
  await assert.rejects(
    Effect.runPromise(
      readIndependentInstallation(
        options({
          environment: { OPENBOT_SELF_HOSTED_API_URL: "" },
        }),
      ),
    ),
  );
  checks.push("An explicit empty pair disables services; an orphan Signal is refused.");

  await writeFile(resourcePath, "not JSON");
  for (const mode of [{ packaged: false }, { independent: false }, { rootDesktop: false }]) {
    assert.equal(await Effect.runPromise(readIndependentInstallation(options(mode))), null);
  }
  checks.push(
    "Development, upstream builds and child/server launches do not read or adopt the packaged configuration.",
  );

  const invalid = [
    { ...fixture, version: 2 },
    { ...fixture, secret: "fixture-not-a-credential" },
    { ...fixture, accountUrl: "http://account.example.com" },
    { ...fixture, accountUrl: "https://api.openbot.run" },
    { ...fixture, accountUrl: "https://api.openbot.run./" },
    { ...fixture, accountUrl: "https://user:fixture@account.example.com" },
    { ...fixture, accountUrl: "https://account.example.com/path" },
    { ...fixture, signalUrl: "ws://signal.example.com/v1/signal" },
    { ...fixture, signalUrl: "wss://signal.openbot.run/v1/signal" },
    { ...fixture, signalUrl: "wss://signal.example.com/v1/signal?token=fixture" },
    { ...fixture, signalUrl: "wss://signal.example.com/v1/signal#fragment" },
    { ...fixture, signalUrl: "wss://signal.example.com/other" },
  ];
  for (const value of invalid) {
    await writeFile(resourcePath, JSON.stringify(value));
    await assert.rejects(Effect.runPromise(readIndependentInstallation(options())));
  }
  await writeFile(resourcePath, " ".repeat(16 * 1_024 + 1));
  await assert.rejects(Effect.runPromise(readIndependentInstallation(options())));
  checks.push("Malformed, oversized, credentialed, wrong-version, non-TLS and original-service resources fail closed.");

  await unlink(resourcePath);
  const missing = await Effect.runPromise(
    readIndependentInstallation(
      options({
        environment: {
          OPENBOT_AUTH_API_URL: "https://api.openbot.run",
          OPENBOT_REMOTE_SIGNAL_URL: "wss://signal.openbot.run/v1/signal",
        },
      }),
    ),
  );
  assert.equal(missing?.accountUrl, null);
  assert.equal(missing?.signalUrl, null);
  assert.equal(missing?.userDataPath, join(appDataPath, INDEPENDENT_USER_DATA_NAME));
  assert.equal(await readFile(retainedFile, "utf8"), "retained user data\n");
  checks.push("A source build without bundled services stays local and retains the original profile.");
  passed = true;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  logger.info("Independent installation checks finished.", { passed, checks: checks.length });
}
