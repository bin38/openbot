import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { E2bCommandResult, E2bDesktopInput, E2bMachine } from "@openbot/contracts/ipc";
import { createOpenBotLogger, redactText, registerSecretValue } from "@openbot/logging";
import { Effect, Fiber, Result } from "effect";
import { handleE2bTool } from "../src/backend/agent/e2b-tools";
import type { GeneratedAttachmentSource } from "../src/backend/attachment-files";
import { e2bCommandSupervisorArguments, e2bScrollSteps } from "../src/main/e2b-command-supervisor";
import { E2bDesktopAdapter, type E2bDesktopAdapterPort } from "../src/main/e2b-desktop-adapter";
import { E2bFailure, e2bFailure } from "../src/main/e2b-desktop-errors";
import { E2bDesktopService } from "../src/main/e2b-desktop-service";
import { type E2bCreation, E2bDesktopStore } from "../src/main/e2b-desktop-store";
import { type E2bOpenUploadSource, openE2bUploadSource } from "../src/main/e2b-upload-source";
import { decodeE2bAgentInput, decodeE2bSettingsInput } from "../src/main/ipc/e2b-inputs";
import type { SecretCipher } from "../src/main/provider-credential-store";

const logger = createOpenBotLogger("e2b-desktop-e2e");
const reportDirectory = resolve(".openbot-build/e2b-desktop-e2e");
const fixtureDirectory = join(reportDirectory, `fixture-${randomUUID()}`);
const checks: string[] = [];

async function run<A>(effect: Effect.Effect<A, { message: string }>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function cipher(): SecretCipher {
  const key = randomBytes(32);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const writer = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([writer.update(value, "utf8"), writer.final()]);
      return Buffer.concat([iv, writer.getAuthTag(), data]);
    },
    decrypt(value) {
      const reader = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      reader.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([reader.update(value.subarray(28)), reader.final()]).toString("utf8");
    },
  };
}

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  return { promise, release };
}

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function processResult(executable: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout }));
  });
}

async function verifySupervisor(): Promise<void> {
  const marker = join(fixtureDirectory, "late-write.txt");
  const delayed = `import time; time.sleep(10); open(${JSON.stringify(marker)}, 'w').write('must not reach takeover')`;
  const command = `nohup python3 -c '${delayed.replaceAll("'", "'\\''")}' >/dev/null 2>&1 </dev/null & echo $!`;
  const result = await processResult("python3", e2bCommandSupervisorArguments(command, 10_000));
  assert.equal(result.code, 0);
  const pid = result.stdout.trim();
  assert.match(pid, /^\d+$/);
  const state = await processResult("ps", ["-o", "stat=", "-p", pid]);
  assert.ok(
    state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
    "A background command survived supervisor completion.",
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const timed = await processResult("python3", e2bCommandSupervisorArguments("sleep 3600", 100));
  assert.equal(timed.code, 124);
  assert.equal(e2bScrollSteps(600), 6);
  assert.equal(e2bScrollSteps(10_000), 20);
  checks.push(
    "real command supervisor kills nohup descendants before completion and enforces deadlines; scrolling converts pixels to bounded wheel steps",
  );
}

/** A local cloud fixture: real disk streams and a real child process, never a live account. */
class FixtureCloud implements E2bDesktopAdapterPort {
  readonly machines = new Map<string, "running" | "paused">();
  readonly viewers = new Map<string, string>();
  readonly creations = new Map<string, string>();
  readonly root: string;
  creates = 0;
  connects = 0;
  deletes = 0;
  pauses = 0;
  inputs = 0;
  touches = 0;
  uploads = 0;
  failConnect = false;
  failInfo = false;
  failStreamStart = false;
  failStreamStop = false;
  failCreation: "invalidTemplate" | "auth" | "unavailable" | null = null;
  holdCommand: { started: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> } | null = null;
  holdUpload: {
    entered: ReturnType<typeof barrier>;
    release: ReturnType<typeof barrier>;
    cancelled: boolean;
    settled: boolean;
  } | null = null;

  constructor(root: string) {
    this.root = root;
  }

  create(_key: string, _agentId: string, creation: E2bCreation) {
    return Effect.tryPromise({
      try: async () => {
        if (this.failCreation) throw e2bFailure(this.failCreation);
        const existing = this.creations.get(creation.idempotencyKey);
        if (existing) return existing;
        const id = `fixture-${++this.creates}`;
        await mkdir(join(this.root, id), { recursive: true });
        this.machines.set(id, "running");
        this.creations.set(creation.idempotencyKey, id);
        return id;
      },
      catch: (cause) => (cause instanceof E2bFailure ? cause : e2bFailure("unavailable")),
    });
  }

  connect(_key: string, id: string) {
    return Effect.suspend(() => {
      if (this.failConnect) return Effect.fail(e2bFailure("unavailable"));
      if (!this.machines.has(id)) return Effect.fail(e2bFailure("machineExpired"));
      this.connects += 1;
      this.machines.set(id, "running");
      return Effect.void;
    });
  }

  info(_key: string, id: string): Effect.Effect<E2bMachine["state"], E2bFailure> {
    return Effect.suspend(() =>
      this.failInfo ? Effect.fail(e2bFailure("auth")) : Effect.succeed(this.machines.get(id) ?? "missing"),
    );
  }

  touch(_id: string, _timeoutMs: number) {
    return Effect.sync(() => {
      this.touches += 1;
    });
  }

  pause(_key: string, id: string) {
    return Effect.sync(() => {
      this.pauses += 1;
      this.machines.set(id, "paused");
    });
  }

  delete(_key: string, id: string) {
    return Effect.sync(() => {
      this.deletes += 1;
      this.machines.delete(id);
      this.viewers.delete(id);
    });
  }

  screenshot(_id: string) {
    return Effect.succeed(new Uint8Array([137, 80, 78, 71]));
  }

  execute(_id: string, command: string): Effect.Effect<E2bCommandResult, E2bFailure> {
    return Effect.tryPromise({
      try: async () => {
        const held = this.holdCommand;
        this.holdCommand = null;
        if (held) {
          held.started.release();
          await held.release.promise;
        }
        const output = await new Promise<string>((resolveOutput, reject) => {
          const child = spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", command], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolveOutput(stdout) : reject(new Error("Fixture process failed.")),
          );
        });
        return { exitCode: 0, stdout: output, stderr: "", truncated: false };
      },
      catch: () => e2bFailure("unavailable"),
    });
  }

  input(_id: string, _input: E2bDesktopInput) {
    return Effect.sync(() => {
      this.inputs += 1;
    });
  }

  upload(
    id: string,
    path: string,
    source: AsyncIterable<Uint8Array>,
    _timeoutMs: number,
    cancelSource: () => Promise<void>,
  ) {
    return Effect.callback<void, E2bFailure>((resume, signal) => {
      const held = this.holdUpload;
      this.holdUpload = null;
      const pending = (async () => {
        this.uploads += 1;
        const destination = join(this.root, id, path.replace(/^\/+/, ""));
        await mkdir(dirname(destination), { recursive: true });
        async function* chunks() {
          for await (const chunk of source) {
            signal.throwIfAborted();
            yield chunk;
            if (held) {
              held.entered.release();
              await held.release.promise;
              signal.throwIfAborted();
            }
          }
        }
        await pipeline(Readable.from(chunks()), createWriteStream(destination), { signal });
      })();
      pending.then(
        () => resume(Effect.void),
        () => resume(Effect.fail(e2bFailure("unavailable"))),
      );
      return Effect.promise(async () => {
        if (held) {
          held.cancelled = true;
          held.release.release();
        }
        await Promise.allSettled([cancelSource(), pending]);
        if (held) held.settled = true;
      });
    });
  }

  download(id: string, path: string): Effect.Effect<ReadableStream<Uint8Array>> {
    const sourcePath = join(this.root, id, path.replace(/^\/+/, ""));
    return Effect.sync(() => {
      let file: FileHandle | null = null;
      return new ReadableStream<Uint8Array>({
        async start() {
          file = await open(sourcePath, "r");
        },
        async pull(controller) {
          if (!file) {
            controller.close();
            return;
          }
          try {
            const chunk = new Uint8Array(256 * 1024);
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) {
              await file.close();
              file = null;
              controller.close();
            } else controller.enqueue(chunk.subarray(0, bytesRead));
          } catch (cause) {
            await file?.close().catch(() => undefined);
            file = null;
            controller.error(cause);
          }
        },
        async cancel() {
          await file?.close();
          file = null;
        },
      });
    });
  }

  startStream(id: string) {
    return Effect.suspend(() => {
      if (this.failStreamStart) return Effect.fail(e2bFailure("stream"));
      const key = randomUUID();
      const url = `https://fixture.invalid/vnc.html?password=${key}`;
      registerSecretValue(key);
      registerSecretValue(url);
      this.viewers.set(id, url);
      return Effect.succeed({ url, trafficAccessToken: "fixture-traffic-token" });
    });
  }

  stopStream(id: string) {
    return Effect.suspend(() => {
      if (this.failStreamStop) return Effect.fail(e2bFailure("stream"));
      this.viewers.delete(id);
      return Effect.void;
    });
  }

  dispose() {
    return Effect.sync(() => {
      this.viewers.clear();
    });
  }
}

async function verifyFixture(): Promise<void> {
  const statePath = join(fixtureDirectory, "e2b.json");
  const workspace = join(fixtureDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  const encryption = cipher();
  const cloud = new FixtureCloud(join(fixtureDirectory, "cloud"));
  const store = new E2bDesktopStore(statePath, encryption);
  await Effect.runPromise(store.load());
  const agents = new Set(["a", "b", "c"]);
  const makeService = (storage: E2bDesktopStore, openUploadSource: E2bOpenUploadSource = openE2bUploadSource) =>
    new E2bDesktopService({
      store: storage,
      adapter: cloud,
      agentExists: (id) => agents.has(id),
      workspaceForAgent: (id) => (id === "a" || id === "b" ? workspace : null),
      downloadDirectory: join(fixtureDirectory, "downloads"),
      openUploadSource,
    });
  let service = makeService(store);
  const secret = `e2b-fixture-key-${randomUUID()}`;
  await run(service.saveSettings({ template: "desktop", timeoutMinutes: 15, apiKey: secret }));
  assert.equal((await readFile(statePath, "utf8")).includes(secret), false);
  assert.equal(redactText(secret).includes(secret), false);
  assert.equal(JSON.stringify(service.getSettings()).includes(secret), false);
  assert.throws(() => decodeE2bSettingsInput({ template: "desktop", timeoutMinutes: 0, apiKey: secret }));
  assert.throws(() => decodeE2bAgentInput({ agentId: "a", sandboxId: "other" }));
  checks.push("encrypted credentials, redaction, and malformed IPC payloads");

  const [a, duplicate] = await Promise.all([run(service.start("a", "agent")), run(service.start("a", "agent"))]);
  assert.equal(a.sandboxId, duplicate.sandboxId);
  assert.equal(cloud.creates, 1);
  const b = await run(service.start("b", "agent"));
  assert.notEqual(a.sandboxId, b.sandboxId);
  const spoofed = await Effect.runPromise(
    handleE2bTool("cloud_computer_execute", { agentId: "b", command: "x" }, "a", service),
  );
  assert.equal(spoofed?.success, false);
  checks.push("concurrent starts create one machine; tool callers cannot choose another agent");

  await run(service.pause("a"));
  const connectsBeforeStatus = cloud.connects;
  const touchesBeforeStatus = cloud.touches;
  assert.equal((await run(service.status("a")))?.state, "paused");
  assert.equal(cloud.connects, connectsBeforeStatus);
  assert.equal(cloud.touches, touchesBeforeStatus);
  await run(service.start("a"));
  const sourcePath = join(workspace, "large.7z");
  const file = await open(sourcePath, "wx");
  await file.truncate(101 * 1024 * 1024);
  await file.write(Buffer.from("archive fixture"), 0, 15, 0);
  await file.close();
  const uploaded = await run(service.upload("a", sourcePath, "/home/user/large.7z"));
  assert.equal(uploaded.bytes, 101 * 1024 * 1024);
  await run(service.pause("a"));
  await run(service.start("a"));
  let consumedPath = "";
  const consumeDownload = (source: GeneratedAttachmentSource) =>
    Effect.tryPromise({
      try: async () => {
        consumedPath = source.path;
        assert.ok(source.path.startsWith(join(fixtureDirectory, "downloads")));
        assert.equal((await source.handle.stat()).size, 101 * 1024 * 1024);
        const first = Buffer.alloc(15);
        await source.handle.read(first, 0, first.length, 0);
        assert.equal(first.toString(), "archive fixture");
        return hash(source.path);
      },
      catch: () => new Error("Download consumer could not read its owned descriptor."),
    });
  const downloadedHash = await run(service.download("a", "/home/user/large.7z", "download.7z", consumeDownload));
  assert.equal(await hash(sourcePath), downloadedHash);
  await assert.rejects(readFile(consumedPath), { code: "ENOENT" });
  await assert.rejects(run(service.upload("a", statePath, "/home/user/key.json")));
  await assert.rejects(
    run(service.download("a", "/home/user/large.7z", join(fixtureDirectory, "outside.7z"), consumeDownload)),
  );
  checks.push(
    "status does not resume; >100 MiB archive streams both ways and survives pause; uploads stay in workspace and downloads cannot choose host directories",
  );

  const heldUpload = { entered: barrier(), release: barrier(), cancelled: false, settled: false };
  const observedUpload: { handle: FileHandle | null } = { handle: null };
  const cancelService = makeService(store, (root, path) =>
    openE2bUploadSource(root, path).pipe(
      Effect.map((source) => {
        observedUpload.handle = source.handle;
        return source;
      }),
    ),
  );
  cloud.holdUpload = heldUpload;
  const uploading = Effect.runFork(cancelService.upload("a", sourcePath, "/home/user/cancelled.7z"));
  await heldUpload.entered.promise;
  await Effect.runPromise(Fiber.interrupt(uploading));
  assert.equal(heldUpload.cancelled, true);
  assert.equal(heldUpload.settled, true);
  assert.equal(observedUpload.handle?.fd, -1);
  const partialUpload = join(cloud.root, a.sandboxId, "home/user/cancelled.7z");
  const partialSize = (await lstat(partialUpload)).size;
  assert.ok(partialSize <= 256 * 1024);
  assert.equal((await run(cancelService.status("a")))?.state, "running");
  assert.equal((await lstat(partialUpload)).size, partialSize);
  await run(cancelService.upload("a", sourcePath, "/home/user/cancelled.7z"));
  assert.equal(await hash(sourcePath), await hash(partialUpload));
  checks.push(
    "interrupting a blocked upload joins its writer, closes the source descriptor, releases the agent lock, and permits retry",
  );

  const racedDirectory = join(workspace, "race");
  const outsideDirectory = join(fixtureDirectory, "outside");
  await mkdir(racedDirectory);
  await mkdir(outsideDirectory);
  await writeFile(join(racedDirectory, "source.bin"), "allowed");
  await writeFile(join(outsideDirectory, "source.bin"), "private data must not upload");
  const uploadsBeforeRace = cloud.uploads;
  const raceService = makeService(store, (root, path) =>
    openE2bUploadSource(root, path, {
      realpath,
      lstat,
      async open(source, flags) {
        await rename(racedDirectory, `${racedDirectory}-original`);
        await symlink(outsideDirectory, racedDirectory, "dir");
        return open(source, flags);
      },
    }),
  );
  try {
    await assert.rejects(run(raceService.upload("a", join(racedDirectory, "source.bin"), "/must-not-leak")));
    assert.equal(cloud.uploads, uploadsBeforeRace);
  } finally {
    await rm(racedDirectory, { force: true });
    await rename(`${racedDirectory}-original`, racedDirectory);
  }
  checks.push("controlled parent-directory symlink race is rejected before any cloud upload byte");

  const held = { started: barrier(), release: barrier() };
  cloud.holdCommand = held;
  const command = run(service.execute("a", "fixture-process-output", 10_000));
  await held.started.promise;
  const takeover = run(service.takeover("a"));
  const blockedInput = assert.rejects(run(service.input("a", { kind: "type", text: "must not type" })));
  held.release.release();
  assert.equal((await command).stdout, "fixture-process-output");
  const viewing = await takeover;
  await blockedInput;
  assert.equal(cloud.inputs, 0);
  assert.equal(service.list().find((machine) => machine.agentId === "a")?.control, "human");
  await assert.rejects(run(service.screenshot("a", "agent")));
  await assert.rejects(run(service.upload("a", sourcePath, "/must-not-upload")));
  assert.equal(redactText(viewing.url).includes(viewing.url), false);
  checks.push("takeover waits for a real process and blocks queued input, screenshots, and file access");

  const restored = new E2bDesktopStore(statePath, encryption);
  await Effect.runPromise(restored.load());
  service = makeService(restored);
  await assert.rejects(run(service.start("a", "agent")));
  cloud.failStreamStop = true;
  await assert.rejects(run(service.handback("a")));
  assert.equal(service.list().find((machine) => machine.agentId === "a")?.control, "human");
  cloud.failStreamStop = false;
  await run(service.handback("a"));
  assert.equal(cloud.viewers.has(a.sandboxId), false);
  const secondView = await run(service.takeover("a"));
  assert.notEqual(viewing.url, secondView.url);
  const beforeDispose = { deletes: cloud.deletes, pauses: cloud.pauses };
  await run(service.dispose());
  assert.equal(cloud.deletes, beforeDispose.deletes);
  assert.equal(cloud.pauses, beforeDispose.pauses);
  assert.equal(service.list().find((machine) => machine.agentId === "a")?.control, "human");
  checks.push(
    "human control survives restart and failed revocation; handback rotates access; shutdown preserves VM data",
  );

  service = makeService(restored);
  await run(service.handback("a"));
  cloud.failConnect = true;
  await assert.rejects(run(service.start("a")));
  cloud.failConnect = false;
  cloud.failInfo = true;
  await assert.rejects(run(service.status("a")));
  cloud.failInfo = false;
  assert.equal(service.list().find((machine) => machine.agentId === "a")?.sandboxId, a.sandboxId);
  assert.equal(cloud.creates, 2);
  await assert.rejects(run(service.saveSettings({ template: "desktop", timeoutMinutes: 15, clearApiKey: true })));
  await assert.rejects(run(service.saveSettings({ template: "desktop", timeoutMinutes: 15, apiKey: "another-key" })));
  await run(
    service.saveSettings({ template: "desktop", timeoutMinutes: 15, clearApiKey: true, confirmKeyReplacement: true }),
  );
  assert.equal(service.getSettings().credentialStatus, "missing");
  assert.equal(service.list().length, 2);
  await run(service.saveSettings({ template: "desktop", timeoutMinutes: 15, apiKey: secret }));
  await run(service.start("a"));
  assert.equal(service.list().find((machine) => machine.agentId === "a")?.sandboxId, a.sandboxId);
  checks.push(
    "network and authentication failures preserve bindings; key replacement and removal require explicit handling",
  );

  cloud.failCreation = "invalidTemplate";
  await run(service.saveSettings({ template: "bad-template", timeoutMinutes: 15 }));
  await assert.rejects(run(service.start("c")));
  assert.deepEqual(service.getSettings().pendingAgentIds, []);
  await run(service.saveSettings({ template: "desktop", timeoutMinutes: 15 }));
  cloud.failCreation = "unavailable";
  await assert.rejects(run(service.start("c")));
  assert.deepEqual(service.getSettings().pendingAgentIds, ["c"]);
  await assert.rejects(run(service.saveSettings({ template: "another-template", timeoutMinutes: 15 })));
  await run(
    service.saveSettings({ template: "desktop", timeoutMinutes: 15, clearApiKey: true, confirmKeyReplacement: true }),
  );
  await assert.rejects(
    run(
      service.saveSettings({
        template: "desktop",
        timeoutMinutes: 15,
        apiKey: "another-account",
        confirmKeyReplacement: true,
      }),
    ),
  );
  await run(service.saveSettings({ template: "desktop", timeoutMinutes: 15, apiKey: secret }));
  cloud.failCreation = null;
  agents.delete("c");
  await assert.rejects(run(service.start("c", "agent")));
  await run(service.start("c"));
  assert.deepEqual(service.getSettings().pendingAgentIds, []);
  await run(service.delete("c"));
  checks.push(
    "invalid templates can be corrected; unknown creation stays retryable with its original account; only a human can recover a deleted agent's pending creation",
  );

  const unreadable = new E2bDesktopStore(statePath, cipher());
  await Effect.runPromise(unreadable.load());
  assert.equal(unreadable.settings().credentialStatus, "unreadable");
  assert.equal(unreadable.settings().machines.length, 2);
  const corruptPath = join(fixtureDirectory, "corrupt.json");
  await writeFile(corruptPath, "corrupt original");
  const corrupt = new E2bDesktopStore(corruptPath, encryption);
  await Effect.runPromise(corrupt.load());
  await assert.rejects(run(corrupt.save({ template: "desktop", timeoutMinutes: 15, apiKey: "new" })));
  assert.equal(await readFile(corruptPath, "utf8"), "corrupt original");
  checks.push("damaged credentials retain machine records; damaged state files are never overwritten");
  await run(service.delete("a"));
  await run(service.delete("b"));
  assert.equal(service.list().length, 0);
}

async function verifyLive(): Promise<void> {
  const apiKey = process.env.OPENBOT_E2B_LIVE_KEY;
  if (!apiKey) throw new Error("--live requires OPENBOT_E2B_LIVE_KEY. No cloud computer was created.");
  const store = new E2bDesktopStore(join(fixtureDirectory, "live.json"), cipher());
  await Effect.runPromise(store.load());
  const agentId = `smoke-${randomUUID()}`;
  const service = new E2bDesktopService({
    store,
    adapter: new E2bDesktopAdapter(),
    agentExists: (id) => id === agentId,
    workspaceForAgent: () => fixtureDirectory,
    downloadDirectory: join(fixtureDirectory, "live-downloads"),
  });
  await run(service.saveSettings({ apiKey, template: "desktop", timeoutMinutes: 5 }));
  try {
    await run(service.start(agentId));
    await run(service.execute(agentId, "printf 'openbot-e2b-ok\\n' > /home/user/openbot-e2e.txt", 10_000));
    const screenshot = await run(service.screenshot(agentId));
    assert.ok(screenshot.base64.length > 0);
    await run(service.pause(agentId));
    await run(service.start(agentId));
    const result = await run(service.execute(agentId, "cat /home/user/openbot-e2e.txt", 10_000));
    assert.match(result.stdout, /openbot-e2b-ok/);
    await run(service.takeover(agentId));
    await assert.rejects(run(service.execute(agentId, "true", 1_000)));
    await run(service.handback(agentId));
    checks.push("live E2B create, execute, screenshot, pause/resume persistence, takeover, and handback");
  } finally {
    await run(service.delete(agentId));
  }
}

await mkdir(fixtureDirectory, { recursive: true });
let passed = false;
const live = process.argv.includes("--live");
try {
  await verifySupervisor();
  await verifyFixture();
  if (live) await verifyLive();
  passed = true;
  logger.info("E2B desktop checks passed.");
} finally {
  await writeFile(
    join(reportDirectory, "report.json"),
    `${JSON.stringify(
      {
        passed,
        liveCloudVerified: live && passed,
        checks,
        scope: live
          ? "service fixture and live E2B account"
          : "service, encrypted state, real local streams and child process; no live E2B account",
      },
      null,
      2,
    )}\n`,
  );
  if (passed || !live) await rm(fixtureDirectory, { recursive: true, force: true });
}
