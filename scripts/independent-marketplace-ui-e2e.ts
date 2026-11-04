// Uses the real Marketplace in one named development app. Opens four plugin setup dialogs,
// cancels without entering credentials or connecting, then searches the public MCP directory.
// It previews one supported connection without testing or saving it. Existing MCP values stay
// in the renderer: only their digest and count leave it for the before/after comparison.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
  usage: "Usage: bun scripts/independent-marketplace-ui-e2e.ts --instance=<id> --allow-mutations",
  options: { instance: { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
assert.ok(instanceId, "Name the development instance to inspect.");
assertMutationAllowed({
  command: "independent-marketplace-ui-e2e",
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

const logger = createOpenBotLogger("independent-marketplace-ui-e2e");
const output = resolve(".openbot-build/independent-marketplace-ui-e2e");
await mkdir(output, { recursive: true });
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const page = session.page;
const checks: string[] = [];
const inspectedPlugins: string[] = [];
let stage = "read initial state";
let failedStage: string | null = null;
let activeDialogTitle: string | null = null;
let cancelLabel = "";
let dialogClosed = true;
let pageErrorCount = 0;
let mcpUnchanged: boolean | null = null;
let defaultUnchanged: boolean | null = null;
let registry: { fresh: boolean; results: number; supported: number } | null = null;
let passed = false;
page.on("pageerror", () => {
  pageErrorCount += 1;
});

async function readState() {
  return page.evaluate(async (localServerId) => {
    const [setup, language, servers, configurations] = await Promise.all([
      window.openbot.getSetupState(),
      window.openbot.getAppLanguagePreference(),
      window.openbot.servers.list(),
      window.openbot.agent.listMcpServers(localServerId),
    ]);
    const bytes = new TextEncoder().encode(
      JSON.stringify([...configurations].sort((left, right) => left.id.localeCompare(right.id))),
    );
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return {
      setup,
      language,
      systemLanguage: navigator.language,
      activeServerId: servers.find((server) => server.active)?.id ?? null,
      mcpCount: configurations.length,
      mcpDigest: digest,
      // Refuse to disconnect or reconfigure an existing target integration.
      targetAlreadyConfigured: configurations.some((config) =>
        ["x", "x-account", "feishu", "github-mcp"].includes(config.name),
      ),
    };
  }, LOCAL_SERVER_ID);
}

let before: Awaited<ReturnType<typeof readState>> | null = null;
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

try {
  before = await readState();
  assert.ok(before.activeServerId === LOCAL_SERVER_ID, "Select this computer before this check.");
  assert.ok(before.setup.completed, "Complete the local setup before this check.");
  assert.ok(!before.targetAlreadyConfigured, "Use an instance where the four target plugins are not connected.");
  assert.ok((await page.getByRole("dialog").count()) === 0, "Close existing dialogs before this check.");
  const t = translateFor(resolveLocale(before.language.language, before.systemLanguage));
  cancelLabel = t("common.cancel");

  stage = "open Marketplace";
  await page.getByRole("button", { name: t("app.rail.marketplace"), exact: true }).click();
  const marketplace = page.getByRole("region", { name: t("marketplace.title"), exact: true });
  await marketplace.waitFor();
  await marketplace
    .getByRole("navigation", { name: t("marketplace.kinds"), exact: true })
    .getByRole("button", { name: new RegExp(`^${literal(t("marketplace.tab.apps"))}(?:\\s*\\d+\\+?)?$`, "u") })
    .click();
  const search = marketplace.getByRole("searchbox", { name: t("marketplace.search.label"), exact: true });
  await search.waitFor();

  const plugins = [
    { name: "X", fields: [t("marketplace.auth.accessToken")] },
    { name: "X Account", fields: [] },
    { name: "飞书 / Feishu", fields: [t("marketplace.auth.appId"), t("marketplace.auth.appSecret")] },
    { name: "GitHub MCP", fields: [t("marketplace.auth.githubToken")] },
  ];
  for (const plugin of plugins) {
    stage = `inspect ${plugin.name}`;
    await search.fill(plugin.name);
    await marketplace.getByRole("button", { name: t("marketplace.open", { name: plugin.name }), exact: true }).click();
    const connect = marketplace.getByRole("button", {
      name: t("marketplace.app.connectNamed", { name: plugin.name }),
      exact: true,
    });
    await connect.waitFor();
    assert.ok(await connect.isEnabled(), "The unconnected plugin must offer its setup dialog.");
    activeDialogTitle = t("mcp.connect.title", { name: plugin.name });
    await connect.click();
    const dialog = page.getByRole("dialog", { name: activeDialogTitle, exact: true });
    await dialog.waitFor();
    for (const label of plugin.fields) {
      // McpKeyDialog uses password inputs. Their required labels include an aria-hidden '*',
      // which label-text matching still sees; password inputs have no implicit textbox role.
      const input = dialog.getByLabel(new RegExp(`^${literal(label)}\\s*\\*?$`, "u"));
      await input.waitFor();
      assert.ok(
        await input.evaluate((element) => element instanceof HTMLInputElement && element.value === ""),
        "A new plugin credential field must be empty.",
      );
    }
    if (plugin.fields.length === 0) {
      await dialog
        .getByRole("heading", { name: t("mcp.local.stdioStepsTitle", { name: plugin.name }), exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: t("marketplace.auth.xurlSetup"), exact: true }).waitFor();
    }
    const cancel = dialog.getByRole("button", { name: cancelLabel, exact: true });
    assert.ok(await cancel.isEnabled(), "Opening setup must not start a connection or local MCP process.");
    await cancel.click();
    await dialog.waitFor({ state: "hidden" });
    activeDialogTitle = null;
    await marketplace
      .getByRole("navigation", { name: t("marketplace.crumbs.label"), exact: true })
      .getByRole("button", { name: t("marketplace.tab.apps"), exact: true })
      .click();
    await search.waitFor();
    inspectedPlugins.push(plugin.name);
  }
  checks.push("X, X Account, Feishu, and GitHub MCP open credential or setup dialogs and cancel without connecting");

  stage = "open public MCP directory";
  await search.fill("");
  activeDialogTitle = t("mcp.registry.title");
  await marketplace.getByRole("button", { name: t("mcp.registry.open"), exact: true }).click();
  const directory = page.getByRole("dialog", { name: activeDialogTitle, exact: true });
  await directory.waitFor();
  const query = directory.getByRole("searchbox", { name: t("mcp.registry.query"), exact: true });
  await query.fill("github");
  stage = "refresh public github search";
  const searchStartedAt = Date.now();
  // Refresh sends refresh:true through the real adapter, so a previous cached page cannot pass.
  await directory.getByRole("button", { name: t("mcp.registry.refresh"), exact: true }).click();
  await directory.getByRole("button", { name: t("mcp.registry.refresh"), exact: true, disabled: false }).waitFor();
  assert.ok((await directory.getByRole("alert").count()) === 0, "The public registry search failed.");
  assert.ok(
    (await directory.getByText(t("mcp.registry.cached"), { exact: true }).count()) === 0,
    "A stale cached registry page cannot pass the live search check.",
  );
  // Read the production adapter's freshly saved page without a refresh. Export counts only.
  registry = await page.evaluate(async (startedAt) => {
    const result = await window.openbot.mcpRegistry.search({ query: "github" });
    return {
      fresh: !result.stale && Date.parse(result.fetchedAt) >= startedAt,
      results: result.servers.length,
      supported: result.servers.filter((server) => server.connections.length > 0).length,
    };
  }, searchStartedAt);
  assert.ok(registry.fresh && registry.supported > 0, "The registry must return a fresh supported connection.");
  checks.push("The public MCP directory returns fresh github results through the real registry service");

  stage = "preview supported MCP connection";
  await directory
    .getByRole("button", { name: t("mcp.registry.configure"), exact: true, disabled: false })
    .first()
    .click();
  await directory.getByRole("textbox", { name: t("mcp.registry.name"), exact: true }).waitFor();
  await directory.getByRole("button", { name: t("mcp.registry.test"), exact: true }).waitFor();
  await directory.getByRole("button", { name: t("mcp.registry.saveDraft"), exact: true }).waitFor();
  await directory.getByRole("button", { name: cancelLabel, exact: true }).click();
  await directory.waitFor({ state: "hidden" });
  activeDialogTitle = null;
  checks.push("A supported MCP configuration opens for review and cancels without testing or saving");

  stage = "save safe Marketplace screenshot";
  await search.fill("GitHub MCP");
  const githubEntry = page.getByRole("button", { name: t("marketplace.open", { name: "GitHub MCP" }), exact: true });
  await githubEntry.waitFor();
  // Only the built-in listing is captured. Other custom rows can show saved addresses.
  // Do not capture a credential dialog or the directory's command/address preview.
  await marketplace
    .getByRole("listitem")
    .filter({ has: githubEntry })
    .screenshot({ path: resolve(output, "marketplace.png") });
  assert.ok(pageErrorCount === 0, "The Marketplace emitted a renderer error.");
  passed = true;
} catch {
  failedStage = stage;
  process.exitCode = 1;
} finally {
  if (activeDialogTitle) {
    try {
      const dialog = page.getByRole("dialog", { name: activeDialogTitle, exact: true });
      if (await dialog.count()) {
        await dialog.getByRole("button", { name: cancelLabel, exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      }
    } catch {
      dialogClosed = false;
      passed = false;
      process.exitCode = 1;
    }
  }
  if (before) {
    try {
      const after = await readState();
      mcpUnchanged = after.mcpCount === before.mcpCount && after.mcpDigest === before.mcpDigest;
      defaultUnchanged =
        after.setup.preferredProvider === before.setup.preferredProvider &&
        after.setup.preferredModel === before.setup.preferredModel;
      if (!mcpUnchanged || !defaultUnchanged) {
        passed = false;
        failedStage ??= "verify unchanged MCP and model settings";
        process.exitCode = 1;
      } else checks.push("MCP configurations and the default provider/model are unchanged");
    } catch {
      passed = false;
      failedStage ??= "read final state";
      process.exitCode = 1;
    }
  }
  try {
    await writeFile(
      resolve(output, "report.json"),
      `${JSON.stringify({ passed, checks, inspectedPlugins, registry, mcpUnchanged, defaultUnchanged, dialogClosed, pageErrorCount, failedStage }, null, 2)}\n`,
    );
  } finally {
    await session.close();
  }
}
if (passed) logger.info("Independent marketplace UI checks passed.");
else
  logger.error(`Independent marketplace UI checks failed at ${failedStage ?? "dialog cleanup"}. Inspect report.json.`);
