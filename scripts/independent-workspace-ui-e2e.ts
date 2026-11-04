// Checks the real named desktop app. It reads published local identity and auth state, then opens
// local settings without changing preferences, model accounts, or files. Main-process network
// isolation is checked separately; this report covers renderer requests and the available UI.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
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
  usage: "Usage: bun scripts/independent-workspace-ui-e2e.ts --instance=<id> --allow-mutations",
  options: { instance: { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
assert.ok(instanceId, "Name the development instance to inspect.");
assertMutationAllowed({
  command: "independent-workspace-ui-e2e",
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
assert.ok(instance, "The named app must belong to this worktree.");
const logger = createOpenBotLogger("independent-workspace-ui-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const page = session.page;
const output = resolve(".openbot-build/independent-workspace-ui-e2e");
await mkdir(output, { recursive: true });
const requests = new Set<string>();
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.hostname === "openbot.run" || url.hostname.endsWith(".openbot.run")) requests.add(url.hostname);
});
const checks: string[] = [];
let passed = false;

try {
  const before = await page.evaluate(async () => ({
    info: await window.openbot.getAppInfo(),
    auth: await window.openbot.auth.getState(),
    setup: await window.openbot.getSetupState(),
    language: await window.openbot.getAppLanguagePreference(),
    systemLanguage: navigator.language,
    presence: await window.openbot.host.getPresence(),
    members: await window.openbot.host.listMembers(),
    inviteCount: (await window.openbot.host.listInvites()).length,
    activeServer: (await window.openbot.servers.list()).find((server) => server.active),
  }));
  const profile = before.info.localWorkspace;
  assert.ok(profile?.id && profile.name);
  assert.equal(before.auth.status, "signed_out", "The local workspace must not manufacture a cloud sign-in.");
  assert.ok(before.presence.members.some((member) => member.id === profile.id && member.role === "owner"));
  assert.ok(before.members.some((member) => member.id === profile.id && member.role === "owner" && !member.disabled));
  assert.ok(Number.isSafeInteger(before.inviteCount) && before.inviteCount >= 0);
  checks.push("A real local owner opens the workspace while the remote account remains signed out");
  checks.push("Local server settings read members and invitations without an account service");
  if (before.activeServer?.thisComputer) {
    const memberId = before.activeServer.currentMemberId;
    assert.ok(memberId, "A running local child must publish its authenticated reader ID.");
    const childPresence = await page.evaluate(
      (id) => window.openbot.servers.getPresenceFor(id),
      before.activeServer.id,
    );
    assert.ok(childPresence.members.some((member) => member.id === memberId));
    checks.push("A local child uses the member ID from its verified login without a remote account session");
  }
  const t = translateFor(resolveLocale(before.language.language, before.systemLanguage));
  if (!before.setup.completed) {
    await page.getByRole("heading", { name: t("onboarding.local.title"), exact: true }).waitFor();
    checks.push("A fresh profile shows local model setup without upstream account or sales onboarding");
  } else {
    assert.equal(await page.getByRole("dialog").count(), 0, "Close any unsaved dialog before this check.");
    const serverTabs = page.getByRole("tablist", { name: t("server.settings.sections"), exact: true });
    if (await serverTabs.isVisible()) {
      assert.equal(
        await serverTabs.getByRole("tab", { name: t("server.settings.membersTitle"), exact: true }).count(),
        0,
      );
      assert.equal(
        await serverTabs.getByRole("tab", { name: t("server.settings.hostedSitesTitle"), exact: true }).count(),
        0,
      );
      if (before.activeServer?.kind === "local")
        assert.equal(
          await serverTabs.getByRole("tab", { name: t("server.cloudComputer.title"), exact: true }).count(),
          1,
        );
      assert.equal(await serverTabs.getByRole("tab", { name: t("server.settings.mcpTitle"), exact: true }).count(), 1);
      checks.push("Server settings retain local E2B/MCP surfaces and omit upstream membership and site hosting");
    }
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
    const tabs = page.getByRole("tablist", { name: t("settings.sections.label"), exact: true });
    await tabs.waitFor();
    for (const label of [
      t("settings.tab.profile.title"),
      t("settings.tab.billing.title"),
      t("settings.tab.updates.title"),
    ]) {
      assert.equal(await tabs.getByRole("tab", { name: label, exact: true }).count(), 0);
    }
    await tabs.getByRole("tab", { name: t("settings.tab.mobileConnect.title"), exact: true }).click();
    await page.getByRole("heading", { name: t("settings.mobileConnect.selfHosted.title"), exact: true }).waitFor();
    const mobileState = before.info.mobileConnectAvailability?.state;
    assert.ok(mobileState === "unconfigured" || mobileState === "local-only");
    await page
      .getByText(
        t(
          mobileState === "unconfigured"
            ? "settings.mobileConnect.selfHosted.unconfigured"
            : "settings.mobileConnect.selfHosted.localOnly",
        ),
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: t("settings.mobileConnect.phones.add"), exact: true }).count(),
      0,
    );
    await page.getByRole("button", { name: t("settings.mobileConnect.selfHosted.guide"), exact: true }).click();
    await page.getByText(t("settings.mobileConnect.selfHosted.localIdentity"), { exact: true }).waitFor();
    checks.push("Phone connection remains visible with self-hosted setup guidance and no local-owner pairing request");
    await tabs.getByRole("tab", { name: t("settings.tab.general.title"), exact: true }).click();
    await page.getByRole("heading", { name: t("settings.localWorkspace.title"), exact: true }).waitFor();
    assert.equal((await page.getByText(profile.name, { exact: true }).count()) > 0, true);
    checks.push(
      "Personal settings keep local identity and phone setup without upstream account, billing, or update tabs",
    );
    const after = await page.evaluate(() => window.openbot.getSetupState());
    assert.equal(after.preferredProvider, before.setup.preferredProvider);
    assert.equal(after.preferredModel, before.setup.preferredModel);
    checks.push("Opening local settings preserves the configured model provider and model");
  }
  assert.equal(requests.size, 0);
  checks.push("Opening these surfaces sends no renderer requests to the upstream account domain");
  await page.screenshot({ path: resolve(output, "local-workspace.png") });
  passed = true;
} finally {
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify({ passed, checks, upstreamRendererHosts: [...requests] }, null, 2)}\n`,
  );
  await session.close();
}
logger.info("Independent workspace UI checks passed.");
