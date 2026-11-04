// Verifies an existing cloud computer through the named dev app. Never reads a key or prints a viewer URL.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp, devBrowserPages } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/e2b-live-ui-e2e.ts --instance=<id> --agent-name=<name> --allow-mutations",
  options: { instance: { type: "string" }, "agent-name": { type: "string" }, "allow-mutations": { type: "boolean" } },
});
if (!args) process.exit(0);
const instanceId = args.values.instance;
const agentName = args.values["agent-name"];
assert.ok(instanceId && agentName, "Name the dev instance and agent.");
const instance = readDevInstanceRecords().find(
  (record) =>
    record.instanceId === instanceId &&
    record.service === "app" &&
    resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named dev instance must belong to this checkout.");
assertMutationAllowed({
  command: "e2b-live-ui-e2e",
  allowMutations: args.values["allow-mutations"] === true,
  instanceNamed: true,
  target: instanceId,
});
const logger = createOpenBotLogger("e2b-live-ui-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  ownerPid: instance.pid,
  expectedRendererPort: instance.rendererPort,
});
const output = resolve(".openbot-build/e2b-live-ui-e2e");
await mkdir(output, { recursive: true });
const report: {
  passed: boolean;
  liveCloudVerified: boolean;
  stage: string;
  checks: string[];
  screenshot: string;
  cleanupSucceeded: boolean;
} = {
  passed: false,
  liveCloudVerified: false,
  stage: "read-state",
  checks: [],
  screenshot: "",
  cleanupSucceeded: false,
};
let agentId: string | null = null;
let wasPaused = false;
let tookControl = false;
try {
  const target = await session.page.evaluate(async (name) => {
    const matches = (await window.openbot.agent.listAgents("local")).filter((agent) => agent.name === name);
    if (matches.length !== 1 || !matches[0]) throw new Error("The agent name is not unique.");
    return { id: matches[0].id, provider: matches[0].provider };
  }, agentName);
  assert.equal(target.provider, "codex");
  agentId = target.id;
  const settings = await session.page.evaluate(() => window.openbot.e2b.getSettings());
  assert.equal(settings.credentialStatus, "saved");
  const before = settings.machines.find((machine) => machine.agentId === target.id);
  assert.ok(before, "This check only uses an existing computer.");
  assert.equal(before.control, "agent", "The user is currently controlling this computer; do not interrupt them.");
  wasPaused = before.state === "paused";
  report.stage = "resume";
  const running = await session.page.evaluate((id) => window.openbot.e2b.start({ agentId: id }), target.id);
  assert.equal(running.sandboxId, before.sandboxId);
  report.checks.push("local Codex agent resumes the same saved E2B computer");
  report.stage = "takeover";
  const human = await session.page.evaluate((id) => window.openbot.e2b.takeover({ agentId: id }), target.id);
  tookControl = true;
  assert.equal(human.control, "human");
  const viewer = devBrowserPages(session.browser).find((page) => {
    try {
      return new URL(page.url()).hostname === `6080-${running.sandboxId}.e2b.app`;
    } catch {
      return false;
    }
  });
  assert.ok(viewer, "The computer viewer did not open.");
  report.stage = "viewer-connection";
  await viewer.screenshot({ path: resolve(output, "viewer-before-connect.png") });
  await viewer.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas !== null && canvas.width > 100 && canvas.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  const bounds = await viewer.locator("canvas").first().boundingBox();
  assert.ok(bounds);
  await viewer.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await viewer.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return false;
      const probe = document.createElement("canvas");
      probe.width = 32;
      probe.height = 32;
      const context = probe.getContext("2d", { willReadFrequently: true });
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
  await viewer.screenshot({ path: resolve(output, "desktop.png") });
  report.screenshot = "desktop.png";
  report.liveCloudVerified = true;
  report.checks.push("authenticated private-port VNC receives a real desktop framebuffer");
  report.stage = "handback";
  const returned = await session.page.evaluate((id) => window.openbot.e2b.handback({ agentId: id }), target.id);
  tookControl = false;
  assert.equal(returned.control, "agent");
  report.checks.push("handback revokes the viewer and restores agent control");
  report.stage = "complete";
  report.passed = true;
} catch {
  logger.error("Live cloud-computer verification failed. The report contains the failing stage, without credentials.");
  process.exitCode = 1;
} finally {
  try {
    if (agentId && tookControl)
      await session.page.evaluate((id) => window.openbot.e2b.handback({ agentId: id }), agentId);
    if (agentId && wasPaused) {
      const paused = await session.page.evaluate((id) => window.openbot.e2b.pause({ agentId: id }), agentId);
      assert.equal(paused.state, "paused");
      report.checks.push("the initially paused computer is paused again without deleting it");
    }
    report.cleanupSucceeded = true;
  } catch {
    process.exitCode = 1;
    report.passed = false;
    logger.error("Cloud computer cleanup needs attention in settings.");
  }
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await session.close();
}
if (report.passed) logger.info("Live E2B viewer verification passed.");
