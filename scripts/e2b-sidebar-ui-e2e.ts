// Uses an existing, selected agent and cloud computer in one named dev app. No key or viewer URL is exported.
// Start with that agent's chat open. The check restores an initially paused computer after it finishes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp, devBrowserPages } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "Usage: bun scripts/e2b-sidebar-ui-e2e.ts --instance=<id> --agent-name=<name> --allow-mutations",
  options: { instance: { type: "string" }, "agent-name": { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
const agentName = args.values["agent-name"];
assert.ok(instanceId && agentName, "Name the development instance and the selected agent.");
assertMutationAllowed({
  command: "e2b-sidebar-ui-e2e",
  allowMutations: args.values["allow-mutations"] === true,
  instanceNamed: true,
  target: instanceId,
});
const instance = readDevInstanceRecords().find(
  (item) =>
    item.instanceId === instanceId && item.service === "app" && resolve(item.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named application must belong to this checkout.");
const logger = createOpenBotLogger("e2b-sidebar-ui-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  ownerPid: instance.pid,
  expectedRendererPort: instance.rendererPort,
});
const page = session.page;
const output = resolve(".openbot-build/e2b-sidebar-ui-e2e");
await mkdir(output, { recursive: true });
const report: {
  passed: boolean;
  stage: string;
  checks: string[];
  nativeWindowEvidence: "same-window" | "unavailable" | "different-window";
  pendingTakeoverObserved: boolean;
  cleanupSucceeded: boolean;
} = {
  passed: false,
  stage: "read-state",
  checks: [],
  nativeWindowEvidence: "unavailable",
  pendingTakeoverObserved: false,
  cleanupSucceeded: false,
};
let agentId: string | null = null;
let initiallyPaused = false;

try {
  const initial = await page.evaluate(async (name) => {
    const agents = (await window.openbot.agent.listAgents("local")).filter((agent) => agent.name === name);
    if (agents.length !== 1 || !agents[0]) throw new Error("The agent name must be unique.");
    const settings = await window.openbot.e2b.getSettings();
    return {
      agent: { id: agents[0].id, provider: agents[0].provider },
      machine: settings.machines.find((machine) => machine.agentId === agents[0]?.id),
      language: await window.openbot.getAppLanguagePreference(),
      systemLanguage: navigator.language,
    };
  }, agentName);
  assert.equal(initial.agent.provider, "codex");
  assert.ok(initial.machine, "This check never creates a cloud computer.");
  assert.equal(initial.machine.control, "agent", "Do not interrupt existing human control.");
  agentId = initial.agent.id;
  initiallyPaused = initial.machine.state === "paused";
  const t = translateFor(resolveLocale(initial.language.language, initial.systemLanguage));
  assert.equal(await page.getByRole("dialog").count(), 0, "Close existing dialogs before this check.");
  await page.getByRole("heading", { name: agentName, exact: true }).waitFor();
  report.stage = "open-side-panel";
  await page.getByRole("button", { name: t("conversation.cloudComputer.open"), exact: true }).click();
  const panel = page.getByRole("complementary", { name: t("conversation.sidePanel.pane.cloudComputer"), exact: true });
  await panel.waitFor();
  if (initial.machine.state !== "running") {
    report.stage = "resume";
    await panel.getByRole("button", { name: t("server.cloudComputer.resume"), exact: true }).click();
  }
  report.stage = "read-only-preview";
  const preview = panel.getByRole("img", { name: t("conversation.cloudComputer.previewAlt"), exact: true });
  await preview.waitFor();
  await page.waitForFunction(
    (alt) => {
      const image = [...document.images].find((item) => item.alt === alt);
      if (!image || image.naturalWidth < 100 || image.naturalHeight < 100) return false;
      const sample = document.createElement("canvas");
      sample.width = 32;
      sample.height = 32;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let visible = 0;
      for (let at = 0; at < pixels.length; at += 4)
        if ((pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0) > 12) visible += 1;
      return visible > 32;
    },
    t("conversation.cloudComputer.previewAlt"),
    { timeout: 30_000 },
  );
  const watching = await page.evaluate((id) => window.openbot.e2b.status({ agentId: id }), agentId);
  assert.equal(watching?.control, "agent");
  assert.equal(watching?.sandboxId, initial.machine.sandboxId);
  await panel.screenshot({ path: resolve(output, "agent-preview.png") });
  report.checks.push(
    "The side panel shows a real read-only desktop image while the same computer remains available to the agent",
  );

  report.stage = "take-control";
  await panel.getByRole("button", { name: t("server.cloudComputer.takeover"), exact: true }).click();
  await panel.getByRole("button", { name: t("server.cloudComputer.handback"), exact: true }).waitFor();
  const human = await page.evaluate((id) => window.openbot.e2b.status({ agentId: id }), agentId);
  assert.equal(human?.control, "human");
  const previewBlocked = await page.evaluate(async (id) => {
    try {
      await window.openbot.e2b.preview({ agentId: id });
      return false;
    } catch {
      return true;
    }
  }, agentId);
  assert.equal(previewBlocked, true, "Automatic preview must not capture a human-controlled desktop.");
  report.checks.push("The automatic preview endpoint refuses capture while the computer is under human control");
  const viewer = devBrowserPages(session.browser).find((candidate) => {
    try {
      return new URL(candidate.url()).hostname === `6080-${initial.machine?.sandboxId}.e2b.app`;
    } catch {
      return false;
    }
  });
  assert.ok(viewer, "The embedded viewer did not open.");
  await viewer.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return Boolean(canvas && canvas.width > 100 && canvas.height > 100);
    },
    undefined,
    { timeout: 30_000 },
  );
  const canvasBounds = await viewer.locator("canvas").first().boundingBox();
  assert.ok(canvasBounds, "The desktop framebuffer has no visible input surface.");
  await viewer.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
  await viewer.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return false;
      const sample = document.createElement("canvas");
      sample.width = 32;
      sample.height = 32;
      const context = sample.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(canvas, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let visible = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        if ((pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0) > 12) visible += 1;
      }
      return visible > 32;
    },
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const mainCdp = await page.context().newCDPSession(page);
  const viewerCdp = await viewer.context().newCDPSession(viewer);
  try {
    // This Browser command returns bounds and a window ID, never a URL or its credentials.
    // Some Electron versions do not implement it for a WebContentsView. Native app screenshot
    // review is then required; do not infer containment from a black or merely nonempty canvas.
    const [mainWindow, viewerWindow] = await Promise.all([
      mainCdp.send("Browser.getWindowForTarget"),
      viewerCdp.send("Browser.getWindowForTarget"),
    ]);
    report.nativeWindowEvidence = mainWindow.windowId === viewerWindow.windowId ? "same-window" : "different-window";
  } catch {
    report.nativeWindowEvidence = "unavailable";
  } finally {
    await mainCdp.detach();
    await viewerCdp.detach();
  }
  assert.notEqual(report.nativeWindowEvidence, "different-window", "The viewer opened in a separate native window.");
  await viewer.screenshot({ path: resolve(output, "human-desktop.png") });
  report.checks.push(
    "Explicit takeover receives a nonblack desktop framebuffer and accepts pointer entry while the computer is under human control",
  );
  if (report.nativeWindowEvidence === "same-window")
    report.checks.push("CDP confirms that the cloud viewer and main renderer belong to the same native window");

  report.stage = "handback";
  await panel.getByRole("button", { name: t("server.cloudComputer.handback"), exact: true }).click();
  await preview.waitFor();
  assert.equal(viewer.isClosed(), true);
  report.checks.push("Returning control closes the viewer and restores the agent's read-only preview");

  report.stage = "close-owned-viewer";
  await panel.getByRole("button", { name: t("server.cloudComputer.takeover"), exact: true }).click();
  await panel.getByRole("button", { name: t("server.cloudComputer.handback"), exact: true }).waitFor();
  await page.getByRole("button", { name: t("conversation.sidePanel.close"), exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await page.waitForFunction(
    async (id) =>
      (await window.openbot.e2b.getSettings()).machines.find((machine) => machine.agentId === id)?.control === "agent",
    agentId,
  );
  report.checks.push("Closing the side panel returns its owned desktop to the agent");

  report.stage = "close-pending-takeover";
  await page.getByRole("button", { name: t("conversation.cloudComputer.open"), exact: true }).click();
  await preview.waitFor();
  const pendingBounds = await preview.boundingBox();
  assert.ok(pendingBounds, "The open panel has no viewer area.");
  let takeoverSettled = false;
  const pendingTakeover = page
    .evaluate(({ id, bounds }) => window.openbot.e2b.takeover({ agentId: id, bounds }), {
      id: agentId,
      bounds: pendingBounds,
    })
    .then(
      () => {
        takeoverSettled = true;
      },
      () => {
        takeoverSettled = true;
      },
    );
  await page.waitForFunction(
    async (id) =>
      (await window.openbot.e2b.getSettings()).machines.find((machine) => machine.agentId === id)?.control === "human",
    agentId,
  );
  report.pendingTakeoverObserved = !takeoverSettled;
  await page.getByRole("button", { name: t("conversation.sidePanel.close"), exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await pendingTakeover;
  // Join main's queue as well: a late cloud response must not leave a view or a human lease behind.
  await page.evaluate((id) => window.openbot.e2b.closeViewer({ agentId: id }), agentId);
  const closed = await page.evaluate((id) => window.openbot.e2b.status({ agentId: id }), agentId);
  assert.equal(closed?.sandboxId, initial.machine.sandboxId);
  assert.equal(closed?.control, "agent");
  assert.ok(
    !devBrowserPages(session.browser).some((candidate) => {
      try {
        return new URL(candidate.url()).hostname === `6080-${initial.machine?.sandboxId}.e2b.app`;
      } catch {
        return false;
      }
    }),
    "Closing the panel left an orphan desktop viewer.",
  );
  report.checks.push(
    report.pendingTakeoverObserved
      ? "Closing during a pending cloud takeover leaves no viewer or human lease after the request settles"
      : "A fast takeover closes without a remaining viewer or human lease; the pending timing was not observed",
  );
  report.stage = "complete";
  report.passed = true;
} catch {
  process.exitCode = 1;
} finally {
  try {
    if (agentId) {
      await page.evaluate((id) => window.openbot.e2b.closeViewer({ agentId: id }), agentId);
      if (initiallyPaused) {
        const current = await page.evaluate((id) => window.openbot.e2b.status({ agentId: id }), agentId);
        assert.equal(current?.control, "agent", "Another viewer now has control; leave it unchanged.");
        const paused = await page.evaluate((id) => window.openbot.e2b.pause({ agentId: id }), agentId);
        assert.equal(paused.state, "paused");
      }
    }
    report.cleanupSucceeded = true;
  } catch {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await session.close();
}
if (report.passed) logger.info("E2B side panel checks passed.");
else logger.error(`E2B side panel check failed at ${report.stage}. Inspect the safe report.`);
