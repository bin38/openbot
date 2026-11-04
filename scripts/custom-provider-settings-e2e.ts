// Drives the real custom-provider form in the named dev app. Open Server settings > Providers >
// Custom provider first. The test adds one temporary loopback endpoint, probes it, edits it, and
// checks that the saved default provider/model stay unchanged. It never changes another endpoint.
// The normal save path can prepare a missing OpenCode/Pi runtime, as a user's first save does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { LOCAL_SERVER_ID, type OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";
import { readScriptArguments } from "./script-arguments";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}

const args = readScriptArguments({
  usage: "Usage: bun scripts/custom-provider-settings-e2e.ts --instance=<id> --allow-mutations",
  options: { instance: { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
assert.ok(instanceId, "Pass --instance=<id> for this worktree's dev app.");
assertMutationAllowed({
  command: "custom-provider-settings-e2e",
  allowMutations: Boolean(args.values["allow-mutations"]),
  instanceNamed: true,
  target: instanceId,
});
const instance = readDevInstanceRecords().find(
  (record) =>
    record.instanceId === instanceId &&
    record.service === "app" &&
    resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named app must belong to this worktree and be running.");

const logger = createOpenBotLogger("custom-provider-settings-e2e");
const output = resolve(".openbot-build/custom-provider-settings-e2e");
const id = `endpoint-e2e-${randomUUID().slice(0, 8)}`;
const name = "Temporary endpoint E2E";
const editedName = "Temporary endpoint E2E edited";
const model = "fixture-coder";
const key = `fixture-key-${randomUUID()}`;
const checks: string[] = [];
type FixtureCleanupStatus = "not-needed" | "removed" | "retained-selected" | "retained-changed" | "retained-unverified";
let modelRequests = 0;
let correctCredential = true;
let retainedSelectedFixture = false;
let cleanupStatus: FixtureCleanupStatus = "not-needed";
let runtimeReadyBefore: boolean | null = null;
let saveRequested = false;
let passed = false;
const server = createServer((request, response) => {
  if (request.url !== "/v1/models") {
    response.writeHead(404).end();
    return;
  }
  modelRequests += 1;
  correctCredential &&= request.headers.authorization === `Bearer ${key}`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: model, object: "model" }] }));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const closeServer = () => new Promise<void>((done) => server.close(() => done()));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
}).catch(async (error) => {
  await closeServer();
  throw error;
});
const page = session.page;
await mkdir(output, { recursive: true });

try {
  const before = await page.evaluate(async () => ({
    setup: await window.openbot.getSetupState(),
    providers: await window.openbot.customProviders.list(),
    status: await window.openbot.agent.getStatus(),
    language: await window.openbot.getAppLanguagePreference(),
    systemLanguage: navigator.language,
    server: (await window.openbot.servers.list()).find((item) => item.active),
  }));
  assert.equal(before.server?.kind, "local", "Run this check against this computer, not a joined host.");
  assert.ok(!before.providers.some((provider) => provider.id === id));
  runtimeReadyBefore = Boolean(
    before.status.providers?.some(
      (provider) =>
        (provider.id === "opencode" || provider.id === "pi") &&
        (provider.state === "available" || provider.state === "sign-in-required"),
    ),
  );
  const t = translateFor(resolveLocale(before.language.language, before.systemLanguage));
  const add = page.getByRole("button", { name: t("provider.custom.addLabel"), exact: true });
  await add.waitFor({ state: "visible" });
  assert.ok(await add.isEnabled(), "Adding an endpoint must not require an already-installed runtime.");
  checks.push(
    runtimeReadyBefore
      ? "Custom provider Add remains available"
      : "Custom provider Add is available before runtime setup",
  );
  await add.click();

  const preset = page.getByRole("dialog", { name: t("customProvider.preset.title"), exact: true });
  await preset.waitFor({ state: "visible" });
  const presetName = t("customProvider.preset.openaiCompatible").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await preset.getByRole("button", { name: new RegExp(presetName) }).click();
  const form = page.getByRole("dialog", { name: t("customProvider.form.title"), exact: true });
  await form.waitFor({ state: "visible" });
  await form.getByRole("textbox", { name: t("customProvider.field.providerId"), exact: true }).fill(id);
  await form.getByRole("textbox", { name: t("customProvider.field.displayName"), exact: true }).fill(name);
  await form.getByRole("textbox", { name: t("customProvider.field.baseUrl"), exact: true }).fill(baseUrl);
  // Password inputs have no implicit textbox role. This field has no required-marker text in its label.
  await form.getByLabel(t("customProvider.field.apiKey"), { exact: true }).fill(key);
  await form.getByRole("button", { name: t("customProvider.discovery.find"), exact: true }).click();
  const discovered = form.getByRole("checkbox", { name: model, exact: true });
  await discovered.waitFor({ state: "visible" });
  await discovered.check();
  assert.ok(modelRequests > 0 && correctCredential, "The real endpoint probe must use only the fixture key.");
  checks.push("A custom API URL and key retrieve real HTTP model metadata");
  saveRequested = true;
  await form.getByRole("button", { name: t("customProvider.submit"), exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const saved = await page.evaluate(
    async (providerId) => ({
      setup: await window.openbot.getSetupState(),
      provider: (await window.openbot.customProviders.list()).find((item) => item.id === providerId),
    }),
    id,
  );
  assert.ok(saved.provider?.hasApiKey && saved.provider.models.some((item) => item.id === model));
  assert.equal(saved.setup.preferredProvider, before.setup.preferredProvider);
  assert.equal(saved.setup.preferredModel, before.setup.preferredModel);
  checks.push("Saving an endpoint preserves the current default provider and model");

  await page.getByRole("button", { name: t("customProvider.list.editLabel", { name }), exact: true }).click();
  const edit = page.getByRole("dialog", { name: t("customProvider.form.editTitle"), exact: true });
  await edit.waitFor({ state: "visible" });
  assert.equal(await edit.getByLabel(t("customProvider.field.apiKey"), { exact: true }).inputValue(), "");
  await edit.getByRole("textbox", { name: t("customProvider.field.displayName"), exact: true }).fill(editedName);
  await edit.getByRole("button", { name: t("customProvider.submit"), exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const edited = await page.evaluate(
    async (providerId) => ({
      setup: await window.openbot.getSetupState(),
      providers: await window.openbot.customProviders.list(),
      provider: (await window.openbot.customProviders.list()).find((item) => item.id === providerId),
    }),
    id,
  );
  assert.equal(edited.provider?.name, editedName);
  assert.equal(edited.provider?.hasApiKey, true);
  assert.equal(edited.setup.preferredProvider, before.setup.preferredProvider);
  assert.equal(edited.setup.preferredModel, before.setup.preferredModel);
  assert.deepEqual(
    edited.providers.filter((provider) => provider.id !== id),
    before.providers,
  );
  checks.push("Editing retains the key and leaves existing endpoints and the default unchanged");
  await page.screenshot({ path: resolve(output, "saved-endpoint.png") });
  passed = true;
} finally {
  try {
    if (saveRequested)
      cleanupStatus = await page.evaluate(
        async ({
          providerId,
          expectedUrl,
          names,
          modelId,
          localServerId,
        }): Promise<"not-needed" | "removed" | "retained-selected" | "retained-changed"> => {
          const fixture = (await window.openbot.customProviders.list()).find((provider) => provider.id === providerId);
          if (!fixture) return "not-needed";
          // A changed endpoint is no longer ours to remove, even when its ID still matches.
          if (
            fixture.baseUrl !== expectedUrl ||
            !names.includes(fixture.name) ||
            fixture.models.length !== 1 ||
            fixture.models[0]?.id !== modelId
          )
            return "retained-changed";
          const [setup, agents] = await Promise.all([
            window.openbot.getSetupState(),
            window.openbot.agent.listAgents(localServerId),
          ]);
          const selected = (choice: { provider: string | null; model: string | null } | undefined): boolean =>
            (choice?.provider === "opencode" || choice?.provider === "pi") &&
            Boolean(choice.model?.startsWith(`${providerId}/`));
          // Check actual saved selections, including hidden agents and choices for a later turn.
          // If either read fails, this callback throws before deletion and the fixture stays saved.
          if (
            selected({ provider: setup.preferredProvider, model: setup.preferredModel }) ||
            agents.some(
              (agent) =>
                selected(agent) ||
                selected(agent.pendingRuntime) ||
                selected(agent.usageLimitReturn) ||
                agent.backupModels?.order.some(selected),
            )
          )
            return "retained-selected";
          await window.openbot.customProviders.delete({ id: providerId });
          return "removed";
        },
        {
          providerId: id,
          expectedUrl: baseUrl,
          names: [name, editedName],
          modelId: model,
          localServerId: LOCAL_SERVER_ID,
        },
      );
    retainedSelectedFixture = cleanupStatus === "retained-selected";
  } catch {
    cleanupStatus = "retained-unverified";
    passed = false;
    process.exitCode = 1;
  } finally {
    await writeFile(
      resolve(output, "report.json"),
      `${JSON.stringify({ passed, checks, modelRequests, runtimeReadyBefore, retainedSelectedFixture, cleanupStatus, fixtureId: id }, null, 2)}\n`,
    );
    await session.close();
    await closeServer();
  }
}
if (passed) logger.info("Custom provider settings checks passed.");
else logger.error("Custom provider settings checks failed; inspect the report before retrying.");
