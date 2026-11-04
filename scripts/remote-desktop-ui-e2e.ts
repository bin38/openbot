// Drives the embedded viewer in the named dev app. The native test panel accepts
// only tagged remote input, so these checks cannot pass through local input.
// Run with --instance=<id> --allow-mutations. Add --normal-input to use an
// isolated Chrome target and a real viewer iframe without the native test mode.
// Reports and screenshots stay in .openbot-build/checks/remote-phone.
// A failed input check must exit non-zero; a visible picture is not an input pass.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { type Browser, chromium } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

interface HostInputEvent {
  type: string;
  code: string;
  key: string;
  keyCode: number;
  defaultPrevented: boolean;
  composing: boolean;
  inputType: string;
  data: string | null;
  valueLength: number;
}

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
    remoteInputProbe?: { mouse: boolean; keys: number; hovered: boolean; events: HostInputEvent[] };
    app?: {
      getInputConfig(): { mouseMode: string };
      getStream(): {
        transport?: { peer?: RTCPeerConnection };
        getInput(): {
          connected: boolean;
          keyboard: { channel?: RTCDataChannel } | null;
          mouseReliable: { channel?: RTCDataChannel } | null;
        };
      };
    };
  }
}

const instanceId = process.argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length);
assert.ok(instanceId, "Name a dev instance with --instance=<id>.");
assertMutationAllowed({
  command: "remote-desktop-ui-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instanceId,
});
const instance = readDevInstanceRecords().find(
  (record) => record.instanceId === instanceId && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.ok(instance, "The named app is not running in this worktree.");
const out = resolve(import.meta.dirname, "../.openbot-build/checks/remote-phone");
mkdirSync(out, { recursive: true });
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("remote-desktop-ui-e2e"), {
  ownerPid: instance.pid,
  expectedRendererPort: instance.rendererPort,
});
const page = session.page;

interface NormalInputReport {
  mode: "pointer-and-keyboard" | "keyboard-only";
  imeReset: boolean;
  passed: boolean;
  mouse: boolean;
  keyboard: boolean;
  cleanup: boolean;
  video: boolean;
  hover: boolean;
  packets: number;
  connected: boolean;
  mouseChannel: string;
  keyboardChannel: string;
  hostHadFocus?: boolean;
  hostKeyEvents?: number;
  hostValueLength?: number;
  hostEvents?: HostInputEvent[];
  targetScreen?: { width: number; height: number; x: number; y: number };
  dataChannels: { label: string; messagesSent: number; bytesSent: number; state: string }[];
}

async function normalInputCheck(): Promise<void> {
  const keyboardOnly = process.argv.includes("--keyboard-only");
  let targetBrowser: Browser | undefined;
  let viewerBrowser: Browser | undefined;
  let normalSessionId: string | undefined;
  const result: NormalInputReport = {
    mode: keyboardOnly ? "keyboard-only" : "pointer-and-keyboard",
    imeReset: process.argv.includes("--reset-ime"),
    passed: false,
    mouse: false,
    keyboard: false,
    cleanup: false,
    video: false,
    hover: false,
    packets: 0,
    connected: false,
    mouseChannel: "",
    keyboardChannel: "",
    dataChannels: [],
  };
  try {
    assert.equal(await page.evaluate(async () => (await window.openbot.remoteDesktop.list()).length), 0);
    const connection = await page.evaluate(() => window.openbot.remoteDesktop.connect({ serverId: "local" }));
    assert.equal(connection.status, "connected", "The normal viewer connection was refused.");
    if (connection.status !== "connected") return;
    normalSessionId = connection.session.id;
    targetBrowser = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: ["--window-position=20,40", "--window-size=500,450"],
    });
    // Preserve the real screen dimensions. A fixed Playwright viewport also emulates
    // screen.width/height, which cannot be used to map a physical desktop input point.
    const target = await targetBrowser.newPage({ viewport: null });
    await target.setContent(`<!doctype html><html><head><title>OpenBot input check</title></head><body style="margin:24px;font:20px sans-serif">
      <h1>OpenBot input check</h1>
      <button type="button" style="width:400px;height:100px">Remote click target</button>
      <p><input aria-label="Remote digits" inputmode="numeric" style="font:24px sans-serif;width:380px"></p>
      <script>window.remoteInputProbe={mouse:false,keys:0,hovered:false,events:[]};
      const field=document.querySelector('input');
      document.querySelector('button').onclick=(event)=>{window.remoteInputProbe.mouse=event.isTrusted;field.focus()};
      document.querySelector('button').onmouseenter=(event)=>{window.remoteInputProbe.hovered=event.isTrusted};
      field.addEventListener('keydown',event=>{if(event.isTrusted)window.remoteInputProbe.keys++});
      for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionend']){
        field.addEventListener(type,event=>{if(event.isTrusted&&window.remoteInputProbe.events.length<40)
          window.remoteInputProbe.events.push({type,code:event.code||'',key:/^(7|3|9|1|Escape|Process|Unidentified)$/.test(event.key||'')?event.key:'',keyCode:event.keyCode||0,defaultPrevented:event.defaultPrevented,composing:Boolean(event.isComposing),inputType:event.inputType||'',data:typeof event.data==='string'&&/^[7391]*$/.test(event.data)?event.data:null,valueLength:field.value.length})});
      }
      </script></body></html>`);
    await target.bringToFront();
    const targetPoint = await target.getByRole("button", { name: "Remote click target" }).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: window.screenX + rect.x + rect.width / 2,
        y: window.screenY + window.outerHeight - window.innerHeight + rect.y + rect.height / 2,
        width: screen.width,
        height: screen.height,
      };
    });
    result.targetScreen = targetPoint;
    viewerBrowser = await chromium.launch({ channel: "chrome", headless: true });
    const viewer = await viewerBrowser.newPage({ viewport: { width: 1200, height: 780 } });
    viewer.on("console", (message) => {
      if (/^(KEYBOARD|MOUSE_|keyboard|mouse_)/.test(message.text())) result.packets += 1;
    });
    const fixtureUrl = new URL("/__openbot_remote_input_fixture", connection.session.viewerUrl).href;
    await viewer.route(fixtureUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe title="Remote viewer" style="position:fixed;inset:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; keyboard-map"></iframe>',
      }),
    );
    await viewer.goto(fixtureUrl);
    await viewer.locator("iframe").evaluate((element: HTMLIFrameElement, source) => {
      element.src = source;
    }, `${connection.session.viewerUrl}#${connection.session.viewerGrant}`);
    const remoteFrame = viewer.locator("iframe").contentFrame();
    const remoteVideo = remoteFrame.locator("video");
    await remoteVideo.waitFor({ state: "attached", timeout: 45_000 });
    await remoteVideo.evaluate((element: HTMLVideoElement) =>
      element.readyState >= 2
        ? Promise.resolve()
        : new Promise<void>((accept, reject) => {
            const deadline = window.setTimeout(() => reject(new Error("The normal viewer has no picture.")), 45_000);
            element.addEventListener(
              "loadeddata",
              () => {
                window.clearTimeout(deadline);
                accept();
              },
              { once: true },
            );
          }),
    );
    result.video = true;
    const streamReady = await remoteFrame.locator("body").evaluate(async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const input = window.app?.getStream().getInput();
        const state = {
          connected: input?.connected ?? false,
          mouseChannel: input?.mouseReliable?.channel?.readyState ?? "",
          keyboardChannel: input?.keyboard?.channel?.readyState ?? "",
        };
        if (
          (state.connected && state.mouseChannel === "open" && state.keyboardChannel === "open") ||
          Date.now() >= deadline
        )
          return state;
        await new Promise((accept) => window.setTimeout(accept, 100));
      }
    });
    Object.assign(result, streamReady);
    assert.equal(result.connected, true);
    const videoBox = await remoteVideo.boundingBox();
    assert.ok(videoBox);
    const encoded = await remoteVideo.evaluate((element: HTMLVideoElement) => ({
      width: element.videoWidth,
      height: element.videoHeight,
    }));
    // Sunshine fits the selected display inside the encoded frame. The viewer then fits
    // that frame inside the video element. Keep both letterbox offsets in the input point.
    const sourceScale = Math.min(encoded.width / targetPoint.width, encoded.height / targetPoint.height);
    const viewerScale = Math.min(videoBox.width / encoded.width, videoBox.height / encoded.height);
    const sourceX = (encoded.width - targetPoint.width * sourceScale) / 2 + targetPoint.x * sourceScale;
    const sourceY = (encoded.height - targetPoint.height * sourceScale) / 2 + targetPoint.y * sourceScale;
    const remotePoint = {
      x: (videoBox.width - encoded.width * viewerScale) / 2 + sourceX * viewerScale,
      y: (videoBox.height - encoded.height * viewerScale) / 2 + sourceY * viewerScale,
    };
    const readDataChannels = () =>
      remoteFrame.locator("body").evaluate(async () => {
        const stats = await window.app?.getStream().transport?.peer?.getStats();
        const channels: { label: string; messagesSent: number; bytesSent: number; state: string }[] = [];
        stats?.forEach((stat) => {
          if (stat.type === "data-channel" && typeof stat.label === "string" && /^(mouse_|keyboard)/.test(stat.label)) {
            channels.push({
              label: stat.label,
              messagesSent: Number(stat.messagesSent),
              bytesSent: Number(stat.bytesSent),
              state: String(stat.state),
            });
          }
        });
        return channels;
      });
    await viewer.screenshot({ path: resolve(out, "normal-before-input.png") });
    if (keyboardOnly) {
      // This sets the keyboard test's precondition. It does not count as remote mouse input.
      await target.getByRole("textbox", { name: "Remote digits" }).focus();
      await target.bringToFront();
    } else {
      await remoteVideo.hover({ position: remotePoint });
      await viewer.mouse.move(videoBox.x + remotePoint.x + 3, videoBox.y + remotePoint.y, { steps: 8 });
      await viewer.mouse.move(videoBox.x + remotePoint.x, videoBox.y + remotePoint.y, { steps: 8 });
      try {
        await target.waitForFunction(() => window.remoteInputProbe?.hovered === true, undefined, { timeout: 10_000 });
      } finally {
        result.dataChannels = await readDataChannels();
        await viewer.screenshot({ path: resolve(out, "normal-after-move.png") });
      }
      result.hover = true;
      await remoteVideo.click({ position: remotePoint });
      await target.waitForFunction(
        () => window.remoteInputProbe?.mouse === true && document.activeElement === document.querySelector("input"),
        undefined,
        { timeout: 10_000 },
      );
    }
    await remoteFrame.locator("#input").focus();
    await target.bringToFront();
    result.hostHadFocus = await target.evaluate(() => document.hasFocus());
    await target.screenshot({ path: resolve(out, "normal-target-focused.png") });
    if (result.imeReset) {
      await viewer.keyboard.press("Escape");
      await target.waitForFunction(
        () => window.remoteInputProbe?.events.some((event) => event.type === "keyup" && event.code === "Escape"),
        undefined,
        { timeout: 10_000 },
      );
    }
    await viewer.keyboard.type("7391");
    const observed = await target.evaluate(async (keyboardOnly) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const mouse = window.remoteInputProbe?.mouse ?? false;
        const keyboard = (window.remoteInputProbe?.keys ?? 0) >= 4 && document.querySelector("input")?.value === "7391";
        if (((keyboardOnly || mouse) && keyboard) || Date.now() >= deadline)
          return {
            mouse,
            keyboard,
            hostKeyEvents: window.remoteInputProbe?.keys ?? 0,
            hostValueLength: document.querySelector("input")?.value.length ?? 0,
            hostEvents: window.remoteInputProbe?.events ?? [],
          };
        await new Promise((accept) => window.setTimeout(accept, 100));
      }
    }, keyboardOnly);
    Object.assign(result, observed);
    result.dataChannels = await readDataChannels();
    await target.screenshot({ path: resolve(out, "normal-target.png") });
    if (!keyboardOnly) assert.equal(result.mouse, true, "The normal remote click did not reach the isolated target.");
    assert.equal(result.keyboard, true, "The normal remote keyboard did not enter the target digits.");
    result.passed = true;
  } finally {
    try {
      if (normalSessionId) {
        await page.evaluate((id) => window.openbot.remoteDesktop.disconnect(id), normalSessionId);
        result.cleanup = await page.evaluate(
          async (id) => !(await window.openbot.remoteDesktop.list()).some((item) => item.id === id),
          normalSessionId,
        );
      }
    } finally {
      await viewerBrowser?.close();
      await targetBrowser?.close();
      result.passed = result.passed && result.cleanup;
      const file = keyboardOnly ? "normal-keyboard.json" : "normal-input.json";
      writeFileSync(resolve(out, file), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  assert.equal(result.cleanup, true);
}

if (process.argv.includes("--normal-input")) {
  try {
    await normalInputCheck();
  } finally {
    await session.close();
  }
  process.exit(0);
}

let ownedSessionId: string | null = null;
let testRequested = false;
interface Report {
  passed: boolean;
  cleanup: boolean;
  cleanupFailed?: boolean;
  video?: { width: number; height: number; readyState: number; time: number };
  videoBox?: { x: number; y: number; width: number; height: number };
  input?: {
    activeTag?: string;
    activeId?: string;
    buttons: (string | null)[];
    overlays: { text: string | null; display: string }[];
  };
  inputResult?: { active: boolean; mouse: boolean; keyboard: boolean };
  viewer?: { mouseMode?: string; connected?: boolean; keyboard?: string; mouse?: string };
  mouseEvent?: { x: number; y: number; target: string | null; prevented: boolean } | null;
  hit?: { parent: string | null; viewer: string | null };
  errors: string[];
  inputPackets: number;
}
const report: Report = { passed: false, cleanup: false, errors: [], inputPackets: 0 };
page.on("pageerror", (error) => report.errors.push(redactText(error.message)));
page.on("console", (message) => {
  if (/^(KEYBOARD|MOUSE_|keyboard|mouse_)/.test(message.text())) report.inputPackets += 1;
});
try {
  const sessions = await page.evaluate(async () =>
    (await window.openbot.remoteDesktop.list()).map(({ id, serverId }) => ({ id, serverId })),
  );
  assert.equal(sessions.length, 0, "End active remote sessions before this check.");
  await page.bringToFront();
  const t = translateFor(resolveLocale("system", await page.evaluate(() => document.documentElement.lang)));
  const remoteTab = page.getByRole("tab", { name: t("server.settings.desktopTitle"), exact: true });
  if (!(await remoteTab.count())) {
    const menuLabel = t("server.menu.open", { name: "__name__" });
    const menuPattern = menuLabel
      .split("__name__")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    await page.getByRole("button", { name: new RegExp(`^${menuPattern}$`) }).click();
    await page.getByRole("menuitem", { name: t("server.rail.settings") }).click();
  }
  await remoteTab.click();
  testRequested = true;
  await page.getByRole("button", { name: t("remoteDesktop.setup.testLocal"), exact: true }).click();
  await page.locator("iframe").waitFor({ state: "attached", timeout: 30_000 });
  ownedSessionId = await page.evaluate(
    async () => (await window.openbot.remoteDesktop.list()).find((item) => item.serverId === "local")?.id ?? null,
  );
  assert.ok(ownedSessionId, "The test did not create a local session.");
  const frame = page.locator("iframe").contentFrame();
  const video = frame.locator("video");
  await video.waitFor({ state: "attached", timeout: 45_000 });
  await video.evaluate((element: HTMLVideoElement) =>
    element.readyState >= 2
      ? Promise.resolve()
      : new Promise<void>((accept, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("No video data.")), 45_000);
          element.addEventListener(
            "loadeddata",
            () => {
              window.clearTimeout(timeout);
              accept();
            },
            { once: true },
          );
        }),
  );
  report.video = await video.evaluate((element: HTMLVideoElement) => ({
    width: element.videoWidth,
    height: element.videoHeight,
    readyState: element.readyState,
    time: element.currentTime,
  }));
  const before = await page.evaluate(
    (sessionId) => window.openbot.remoteDesktop.test({ serverId: "local", sessionId, action: "status" }),
    ownedSessionId,
  );
  assert.ok(before.active, "The native test panel is not active.");
  const box = await video.boundingBox();
  assert.ok(box, "The viewer has no visible video area.");
  report.videoBox = box;
  report.input = await frame.locator("body").evaluate(() => ({
    activeTag: document.activeElement?.tagName,
    activeId: document.activeElement?.id,
    buttons: Array.from(document.querySelectorAll("button")).map((element) => element.textContent),
    overlays: Array.from(document.querySelectorAll("dialog, .modal-background")).map((element) => ({
      text: element.textContent,
      display: getComputedStyle(element).display,
    })),
  }));
  await page.screenshot({ path: resolve(out, "viewer-before-input.png") });
  report.viewer = await frame.locator("body").evaluate(() => ({
    mouseMode: window.app?.getInputConfig().mouseMode,
    connected: window.app?.getStream().getInput().connected,
    keyboard: window.app?.getStream().getInput().keyboard?.channel?.readyState,
    mouse: window.app?.getStream().getInput().mouseReliable?.channel?.readyState,
  }));
  report.hit = {
    parent: await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2 + 20,
    }),
    viewer: await video.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2 + 20);
      return hit ? `${hit.tagName}#${hit.id}` : null;
    }),
  };
  const receivedMouse = frame.locator("body").evaluate(
    () =>
      new Promise<Report["mouseEvent"]>((accept) => {
        const timeout = window.setTimeout(() => accept(null), 5_000);
        document.addEventListener(
          "mousedown",
          (event) => {
            window.clearTimeout(timeout);
            accept({
              x: event.clientX,
              y: event.clientY,
              target: event.target instanceof Element ? event.target.id : null,
              prevented: event.defaultPrevented,
            });
          },
          { once: true, capture: true },
        );
      }),
  );
  await video.click({ position: { x: box.width / 2, y: box.height / 2 + 20 } });
  report.mouseEvent = await receivedMouse;
  await frame.locator("#input").pressSequentially(before.code);
  const after = await page.evaluate(async (sessionId) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await window.openbot.remoteDesktop.test({ serverId: "local", sessionId, action: "status" });
      if (!status.active || (status.mouse && status.keyboard) || Date.now() >= deadline) return status;
      await new Promise((accept) => window.setTimeout(accept, 100));
    }
  }, ownedSessionId);
  report.inputResult = { active: after.active, mouse: after.mouse, keyboard: after.keyboard };
  await page.screenshot({ path: resolve(out, "viewer-after-input.png") });
  assert.equal(after.mouse, true, "The remote mouse did not reach the target.");
  assert.equal(after.keyboard, true, "The remote keyboard did not enter the test code.");
  report.passed = true;
} finally {
  try {
    if (testRequested && !ownedSessionId) {
      ownedSessionId = await page.evaluate(
        async () => (await window.openbot.remoteDesktop.list()).find((item) => item.serverId === "local")?.id ?? null,
      );
    }
    if (ownedSessionId) {
      await page.evaluate(async (sessionId) => {
        try {
          await window.openbot.remoteDesktop.test({ serverId: "local", sessionId, action: "stop" });
        } finally {
          await window.openbot.remoteDesktop.disconnect(sessionId);
        }
      }, ownedSessionId);
      report.cleanup = !(await page.evaluate(
        async (sessionId) => (await window.openbot.remoteDesktop.list()).some((item) => item.id === sessionId),
        ownedSessionId,
      ));
    }
  } catch {
    report.cleanupFailed = true;
  } finally {
    report.passed = report.passed && report.cleanup;
    writeFileSync(resolve(out, "ui-e2e.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    await session.close();
  }
}
assert.equal(report.cleanup, true, "The remote test cleanup was not confirmed.");
