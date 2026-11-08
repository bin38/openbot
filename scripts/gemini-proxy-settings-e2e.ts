import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { GeminiProxySettingsStore } from "../src/main/gemini-proxy-settings-store";

const logger = createOpenBotLogger("gemini-proxy-settings-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-gemini-proxy-"));
const output = resolve(".openbot-build/gemini-proxy-settings-e2e");
const checks: string[] = [];
let passed = false;
try {
  const path = join(root, "settings.json");
  const first = new GeminiProxySettingsStore(path);
  await Effect.runPromise(first.load());
  assert.equal(first.get().enabled, false);
  const enabled = { enabled: true, proxyUrl: "http://127.0.0.1:7897" };
  await Effect.runPromise(first.set(enabled));
  const reopened = new GeminiProxySettingsStore(path);
  await Effect.runPromise(reopened.load());
  assert.deepEqual(reopened.get(), enabled);
  await Effect.runPromise(reopened.set({ ...enabled, enabled: false }));
  const disabled = new GeminiProxySettingsStore(path);
  await Effect.runPromise(disabled.load());
  assert.equal(disabled.get().enabled, false);
  assert.equal(disabled.get().proxyUrl, enabled.proxyUrl);
  checks.push("Enable, restart and disable preserve the saved proxy address through the real preference file.");

  for (const [index, content] of [
    "invalid-json",
    JSON.stringify({ version: 2, settings: enabled }),
    JSON.stringify({ version: 1, settings: { enabled: true, proxyUrl: "http://user:fixture@proxy.invalid" } }),
  ].entries()) {
    const invalidPath = join(root, `invalid-${index}.json`);
    await writeFile(invalidPath, content);
    const store = new GeminiProxySettingsStore(invalidPath);
    await Effect.runPromise(store.load());
    assert.throws(() => store.get(), /cannot read the saved Gemini proxy settings/u);
    await assert.rejects(Effect.runPromise(store.set(enabled)));
    assert.equal(await readFile(invalidPath, "utf8"), content);
  }
  checks.push("Unreadable, future-version and credential-bearing files block Gemini and remain untouched.");

  const brokenParent = join(root, "parent-file");
  await writeFile(brokenParent, "retained");
  const failed = new GeminiProxySettingsStore(join(brokenParent, "settings.json"));
  await assert.rejects(Effect.runPromise(failed.set(enabled)));
  assert.equal(failed.get().enabled, false);
  assert.equal(await readFile(brokenParent, "utf8"), "retained");
  checks.push("A failed atomic write keeps the in-memory setting and existing file intact.");
  passed = true;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  logger.info("Gemini proxy preference checks finished.", { passed, checks: checks.length });
}
