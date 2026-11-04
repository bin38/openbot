// Drives the real local API endpoint editor and a loopback-only HTTP service. No vendor API is called.
// Open Server settings first. The temporary endpoint is removed only when it still matches this check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { ApiChannelDefinition, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { createOpenBotLogger, redactText, registerSecretValue } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";
import { readScriptArguments } from "./script-arguments";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}

const args = readScriptArguments({
  usage: "Usage: bun scripts/api-channels-ui-e2e.ts --instance=<id> --allow-mutations",
  options: { instance: { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
assert.ok(instanceId);
assertMutationAllowed({
  command: "api-channels-ui-e2e",
  allowMutations: Boolean(args.values["allow-mutations"]),
  instanceNamed: true,
  target: instanceId,
});
const instance = readDevInstanceRecords().find(
  (item) =>
    item.instanceId === instanceId && item.service === "app" && resolve(item.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named dev app must belong to this checkout.");

const logger = createOpenBotLogger("api-channels-ui-e2e");
const output = resolve(".openbot-build/api-channels-ui-e2e");
const suffix = randomUUID();
const name = `API UI fixture ${suffix}`;
const editedName = `API UI fixture edited ${suffix}`;
const key = `fixture-${randomUUID()}`;
registerSecretValue(key, { allowShort: true });
let requests = 0;
let jsonRequests = 0;
let multipartRequests = 0;
let deferredRequests = 0;
let correctCredential = true;
let correctBody = true;
let correctMultipart = true;
let correctDeferred = true;
const deferredStarted = Promise.withResolvers<void>();
const releaseDeferred = Promise.withResolvers<void>();
const server = createServer((request, response) => {
  if (!["/echo", "/multipart", "/deferred"].includes(request.url ?? "") || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  requests += 1;
  correctCredential &&= request.headers.authorization === `Bearer ${key}`;
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.url === "/deferred") {
      deferredRequests += 1;
      try {
        const payload = JSON.parse(body);
        correctDeferred &&=
          isDynamicRecord(payload) && payload.input === "ui-background" && Object.keys(payload).length === 1;
      } catch {
        correctDeferred = false;
      }
      deferredStarted.resolve();
      void releaseDeferred.promise.then(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echo: "ui-background", marker: "api-endpoint-background-fixture" }));
      });
      return;
    }
    if (request.url === "/echo") {
      jsonRequests += 1;
      try {
        const payload = JSON.parse(body);
        correctBody &&= isDynamicRecord(payload) && payload.input === "ui-smoke" && Object.keys(payload).length === 1;
      } catch {
        correctBody = false;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ echo: "ui-smoke", marker: "api-endpoint-fixture" }));
      return;
    }
    multipartRequests += 1;
    correctMultipart &&= request.headers["transfer-encoding"] === "chunked";
    const contentType = request.headers["content-type"];
    // Decode the actual MIME envelope, not a serializer-specific byte layout. No file part is used.
    const verifyMultipart = async () => {
      try {
        if (typeof contentType !== "string" || !/^multipart\/form-data\s*;.*boundary=/iu.test(contentType)) {
          correctMultipart = false;
          return;
        }
        const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
        correctMultipart &&= form.get("input") === "ui-multipart" && form.get("fixed") === "fixture-value";
        correctMultipart &&= [...form.keys()].sort().join(",") === "fixed,input";
      } catch {
        correctMultipart = false;
      } finally {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echo: "ui-multipart", marker: "api-endpoint-multipart-fixture" }));
      }
    };
    void verifyMultipart();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const definition: ApiChannelDefinition = {
  name,
  description: "Temporary loopback UI fixture",
  baseUrl,
  auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
  headers: [],
  artifactHosts: [],
  operations: [
    {
      id: "echo",
      name: "Echo",
      description: "Loopback fixture only",
      method: "POST",
      path: "/echo",
      bodyType: "json",
      body: JSON.stringify({ input: "{{input}}" }),
      query: [],
      parameters: [
        { name: "input", type: "string", required: true, description: "Fixture input", defaultJson: '"ui-smoke"' },
      ],
      readOnly: true,
      response: {
        format: "json",
        resultPath: "echo",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
    {
      id: "multipart_echo",
      name: "Multipart echo",
      description: "Loopback text multipart fixture only",
      method: "POST",
      path: "/multipart",
      bodyType: "multipart",
      body: JSON.stringify({ input: "{{input}}", fixed: "fixture-value" }),
      query: [],
      parameters: [
        {
          name: "input",
          type: "string",
          required: true,
          description: "Fixture text input",
          defaultJson: '"ui-multipart"',
        },
      ],
      readOnly: true,
      response: {
        format: "json",
        resultPath: "echo",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
    {
      id: "deferred_echo",
      name: "Deferred echo",
      description: "Loopback response released by the check",
      method: "POST",
      path: "/deferred",
      bodyType: "json",
      body: JSON.stringify({ input: "{{input}}" }),
      query: [],
      parameters: [
        {
          name: "input",
          type: "string",
          required: true,
          description: "Fixture background input",
          defaultJson: '"ui-background"',
        },
      ],
      readOnly: true,
      response: {
        format: "json",
        resultPath: "echo",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
  ],
};
const closeServer = () => {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
};
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  ownerPid: instance.pid,
  expectedRendererPort: instance.rendererPort,
}).catch(async (error) => {
  await closeServer();
  throw error;
});
const page = session.page;
await mkdir(output, { recursive: true });
const checks: string[] = [];
let fixtureId: string | null = null;
let lastUpdatedAt: string | null = null;
let cleanupStatus = "not-needed";
let stage = "read-state";
let passed = false;
let defaultUnchanged = false;
let pageErrors = 0;
let failureMessage: string | null = null;
page.on("pageerror", () => {
  pageErrors += 1;
});

try {
  const before = await page.evaluate(async () => ({
    setup: await window.openbot.getSetupState(),
    channels: await window.openbot.apiChannels.list(),
    language: await window.openbot.getAppLanguagePreference(),
    systemLanguage: navigator.language,
    activeServer: (await window.openbot.servers.list()).find((server) => server.active),
  }));
  assert.equal(before.activeServer?.kind, "local");
  assert.equal(await page.getByRole("dialog").count(), 0, "Close any unsaved dialog before this check.");
  const t = translateFor(resolveLocale(before.language.language, before.systemLanguage));
  stage = "open-api-settings";
  await page.getByRole("tab", { name: t("apiChannels.title"), exact: true }).click();
  await page.getByRole("button", { name: t("apiChannels.add"), exact: true }).click();
  const editor = page.getByRole("dialog", { name: t("apiChannels.editor.addTitle"), exact: true });
  await editor.waitFor();
  stage = "import-and-validate";
  await editor.getByRole("button", { name: t("apiChannels.editor.import"), exact: true }).click();
  await editor
    .getByRole("textbox", { name: t("apiChannels.editor.importJson"), exact: true })
    .fill(JSON.stringify(definition));
  await editor.getByRole("button", { name: t("apiChannels.editor.applyImport"), exact: true }).click();
  await editor.getByText(t("apiChannels.editor.validated"), { exact: true }).waitFor();
  assert.equal(requests, 0, "Import and validation must not invoke an endpoint.");
  assert.equal(
    await editor.getByRole("textbox", { name: t("apiChannels.editor.name"), exact: true }).inputValue(),
    name,
  );
  checks.push(
    "The real editor imports and validates a complete declarative HTTP endpoint without making a service request",
  );
  stage = "change-auth-type";
  await editor.getByRole("button", { name: t("apiChannels.editor.auth") }).click();
  await page.getByRole("option", { name: t("apiChannels.editor.auth.header"), exact: true }).click();
  await editor.getByRole("textbox", { name: t("apiChannels.editor.authName"), exact: true }).waitFor();
  await editor.getByRole("button", { name: t("apiChannels.editor.auth") }).click();
  await page.getByRole("option", { name: t("apiChannels.editor.auth.bearer"), exact: true }).click();
  assert.equal(requests, 0, "Changing authentication must not invoke an endpoint.");
  checks.push("The authentication menu opens inside the editor and permits changes in both directions");
  stage = "save-endpoint";
  await editor.getByLabel(t("apiChannels.editor.key"), { exact: true }).fill(key);
  const enabledSwitch = editor.getByRole("switch", { name: t("apiChannels.editor.enable"), exact: true });
  assert.equal(await enabledSwitch.isChecked(), false);
  // The visible label activates the associated input. The switch's input is visually hidden.
  await editor.getByText(t("apiChannels.editor.enable"), { exact: true }).click();
  assert.equal(await enabledSwitch.isChecked(), true);
  await editor.getByRole("button", { name: t("apiChannels.editor.save"), exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const created = await page.evaluate(
    async (name) => (await window.openbot.apiChannels.list()).find((channel) => channel.definition.name === name),
    name,
  );
  assert.ok(
    created && created.definition.baseUrl === baseUrl && created.credentialStatus === "saved" && created.enabled,
  );
  fixtureId = created.id;
  lastUpdatedAt = created.updatedAt;
  assert.equal(requests, 0, "Saving a channel must not invoke it.");
  checks.push("Saving an enabled endpoint stores the credential without making a service request");

  stage = "edit-without-key";
  await page.getByRole("button", { name: t("apiChannels.edit", { name }), exact: true }).click();
  const edit = page.getByRole("dialog", { name: t("apiChannels.editor.editTitle"), exact: true });
  await edit.waitFor();
  assert.equal(await edit.getByLabel(t("apiChannels.editor.key"), { exact: true }).inputValue(), "");
  await edit.getByRole("textbox", { name: t("apiChannels.editor.name"), exact: true }).fill(editedName);
  await edit.getByRole("button", { name: t("apiChannels.editor.save"), exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const edited = await page.evaluate(
    async (id) => (await window.openbot.apiChannels.list()).find((channel) => channel.id === id),
    fixtureId,
  );
  assert.ok(edited?.credentialStatus === "saved" && edited.definition.name === editedName);
  lastUpdatedAt = edited.updatedAt;
  checks.push("Editing shows no saved key and retains it when the field is left empty");

  stage = "explicit-loopback-run";
  await page.getByRole("button", { name: t("apiChannels.run.open", { name: editedName }), exact: true }).click();
  const runner = page.getByRole("dialog", { name: t("apiChannels.run.title"), exact: true });
  await runner.waitFor();
  assert.equal(requests, 0);
  await runner
    .getByRole("textbox", { name: t("apiChannels.run.values"), exact: true })
    .fill(JSON.stringify({ input: "ui-smoke" }));
  await runner.getByRole("button", { name: t("apiChannels.run.execute"), exact: true }).click();
  const response = runner.getByRole("textbox", { name: t("apiChannels.run.output"), exact: true });
  await response.waitFor();
  assert.equal(await response.inputValue(), "ui-smoke");
  assert.equal(requests, 1);
  assert.equal(jsonRequests, 1);
  assert.equal(multipartRequests, 0);
  assert.ok(correctCredential && correctBody);
  await runner.screenshot({ path: resolve(output, "loopback-result.png") });
  checks.push(
    "Only an explicit Run action sends the configured JSON and saved credential to the loopback endpoint and displays its mapped result",
  );

  stage = "explicit-loopback-multipart-run";
  // The Select trigger's accessible name includes its currently selected option.
  await runner.getByRole("button", { name: /Echo$/u }).click();
  await page.getByRole("option", { name: "Multipart echo", exact: true }).click();
  await response.waitFor({ state: "hidden" });
  assert.equal(requests, 1, "Selecting the multipart operation must not invoke it.");
  await runner
    .getByRole("textbox", { name: t("apiChannels.run.values"), exact: true })
    .fill(JSON.stringify({ input: "ui-multipart" }));
  await runner.getByRole("button", { name: t("apiChannels.run.execute"), exact: true }).click();
  await response.waitFor();
  assert.equal(await response.inputValue(), "ui-multipart");
  assert.equal(requests, 2);
  assert.equal(jsonRequests, 1);
  assert.equal(multipartRequests, 1);
  assert.ok(correctCredential && correctMultipart);
  await runner.screenshot({ path: resolve(output, "multipart-result.png") });
  checks.push(
    "The native Electron transport sends one streamed multipart request with a valid boundary, both text fields, and the saved bearer credential; no file input is read",
  );

  stage = "leave-running-request";
  await runner.getByRole("button", { name: /Multipart echo$/u }).click();
  await page.getByRole("option", { name: "Deferred echo", exact: true }).click();
  await runner.getByRole("button", { name: t("apiChannels.run.execute"), exact: true }).click();
  await deferredStarted.promise;
  await runner.getByText(t("apiChannels.run.backgroundHint"), { exact: true }).waitFor();
  assert.equal(requests, 3);
  assert.equal(deferredRequests, 1);
  assert.ok(correctCredential && correctDeferred);
  await runner
    .getByRole("button", { name: t("apiChannels.run.returnToHistory"), exact: true })
    .first()
    .click();
  await runner.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: t("apiChannels.history.openLabel", { name: "Deferred echo" }), exact: true })
    .waitFor();
  const pending = await page.evaluate(
    async (channelId) =>
      (await window.openbot.apiChannels.listRuns({ channelId })).find((run) => run.operationId === "deferred_echo"),
    fixtureId,
  );
  assert.ok(pending && pending.status === "pending");
  // Other settings remain usable while the host owns the unfinished request.
  await page.getByRole("tab", { name: t("server.settings.generalTitle"), exact: true }).click();
  await page.getByRole("tab", { name: t("server.settings.generalTitle"), exact: true, selected: true }).waitFor();
  await page.getByRole("tab", { name: t("apiChannels.title"), exact: true }).click();
  await page.getByRole("button", { name: t("apiChannels.run.open", { name: editedName }), exact: true }).click();
  await runner.waitFor();
  releaseDeferred.resolve();
  await page.waitForFunction(
    async (id) => (await window.openbot.apiChannels.getRun({ id })).status === "completed",
    pending.id,
  );
  assert.equal(await runner.isVisible(), true, "The earlier completion must not close the current dialog.");
  assert.equal(await response.count(), 0, "The earlier completion must not replace the current dialog's result.");
  await runner.getByRole("button", { name: /Echo$/u }).waitFor();
  assert.equal(requests, 3, "Closing, navigation, and the earlier completion must not submit another request.");
  await runner
    .getByRole("button", { name: t("common.close"), exact: true })
    .first()
    .click();
  await runner.waitFor({ state: "hidden" });

  stage = "read-background-result";
  await page.getByRole("button", { name: t("apiChannels.history.refresh"), exact: true }).click();
  await page
    .getByRole("button", { name: t("apiChannels.history.openLabel", { name: "Deferred echo" }), exact: true })
    .click();
  const savedResult = page.getByRole("dialog", { name: t("apiChannels.history.resultTitle"), exact: true });
  const savedOutput = savedResult.getByRole("textbox", { name: t("apiChannels.run.output"), exact: true });
  await savedOutput.waitFor();
  assert.equal(await savedOutput.inputValue(), "ui-background");
  assert.equal(await savedResult.getByRole("button", { name: t("apiChannels.run.execute"), exact: true }).count(), 0);
  assert.equal(requests, 3, "Opening a saved background result must not send another service request.");
  await savedResult.screenshot({ path: resolve(output, "background-result.png") });
  await savedResult
    .getByRole("button", { name: t("common.close"), exact: true })
    .first()
    .click();
  await savedResult.waitFor({ state: "hidden" });
  checks.push(
    "A pending request continues after returning to history and settings navigation; its completion preserves the new dialog, and its saved result opens without another request",
  );

  stage = "disable-and-preserve-default";
  // Exercise the keyboard path of this compact, label-free list switch.
  await page
    .getByRole("switch", { name: t("apiChannels.enableLabel", { name: editedName }), exact: true })
    .press("Space");
  await page.waitForFunction(
    async (id) => (await window.openbot.apiChannels.list()).find((channel) => channel.id === id)?.enabled === false,
    fixtureId,
  );
  const after = await page.evaluate(async () => ({
    setup: await window.openbot.getSetupState(),
    channels: await window.openbot.apiChannels.list(),
  }));
  const disabled = after.channels.find((channel) => channel.id === fixtureId);
  assert.ok(disabled && !disabled.enabled);
  lastUpdatedAt = disabled.updatedAt;
  defaultUnchanged =
    after.setup.preferredProvider === before.setup.preferredProvider &&
    after.setup.preferredModel === before.setup.preferredModel;
  assert.ok(defaultUnchanged);
  assert.deepEqual(
    after.channels.filter((channel) => channel.id !== fixtureId),
    before.channels,
  );
  checks.push(
    "Disabling preserves the endpoint and credential; existing endpoints and the default chat provider/model are unchanged",
  );
  stage = "navigation-remains-responsive";
  const navigation = page.getByRole("navigation", { name: t("app.rail.label"), exact: true });
  await navigation.getByRole("button", { name: t("app.rail.computerUse"), exact: true }).click();
  await page.getByRole("tab", { name: t("settings.tab.computerUse.title"), exact: true, selected: true }).waitFor();
  await navigation.getByRole("button", { name: t("app.rail.agents"), exact: true }).click();
  await page.getByRole("tablist", { name: t("settings.sections.label"), exact: true }).waitFor({ state: "hidden" });
  assert.equal(pageErrors, 0);
  checks.push("Global navigation still opens Computer Use and returns to the workspace after endpoint operations");
  passed = true;
} catch (error) {
  failureMessage = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1_200);
  process.exitCode = 1;
} finally {
  releaseDeferred.resolve();
  try {
    if (fixtureId && lastUpdatedAt)
      cleanupStatus = await page.evaluate(
        async ({ id, updatedAt, baseUrl, names }) => {
          const current = (await window.openbot.apiChannels.list()).find((channel) => channel.id === id);
          if (!current) return "not-needed";
          if (
            current.updatedAt !== updatedAt ||
            current.definition.baseUrl !== baseUrl ||
            !names.includes(current.definition.name)
          )
            return "retained-changed";
          await window.openbot.apiChannels.delete({ id });
          return "removed";
        },
        { id: fixtureId, updatedAt: lastUpdatedAt, baseUrl, names: [name, editedName] },
      );
  } catch {
    cleanupStatus = "retained-unverified";
    passed = false;
    process.exitCode = 1;
  } finally {
    await writeFile(
      resolve(output, "report.json"),
      `${JSON.stringify({ passed, stage, checks, requests, jsonRequests, multipartRequests, deferredRequests, correctCredential, correctBody, correctMultipart, correctDeferred, defaultUnchanged, pageErrors, cleanupStatus, failureMessage }, null, 2)}\n`,
    );
    await session.close();
    await closeServer();
  }
}
if (passed) logger.info("API endpoint UI checks passed.");
else logger.error(`API endpoint UI check failed at ${stage}: ${failureMessage ?? "inspect the safe report"}`);
