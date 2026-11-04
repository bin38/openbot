import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import type {
  E2bDesktopInput,
  E2bFileResult,
  E2bMachine,
  E2bScreenshot,
  SaveE2bSettingsInput,
} from "@openbot/contracts/ipc";
import { Effect, Result, Semaphore } from "effect";
import type { GeneratedAttachmentSource } from "../backend/attachment-files";
import type { E2bDesktopAdapterPort, E2bDesktopStream } from "./e2b-desktop-adapter";
import { E2bFailure, e2bFailure } from "./e2b-desktop-errors";
import type { E2bDesktopStore } from "./e2b-desktop-store";
import { type E2bOpenUploadSource, openE2bUploadSource } from "./e2b-upload-source";

export interface E2bDesktopServiceOptions {
  store: E2bDesktopStore;
  adapter: E2bDesktopAdapterPort;
  agentExists: (agentId: string) => boolean;
  workspaceForAgent: (agentId: string) => string | null;
  /** A main-owned directory under userData; never selected by a tool or the renderer. */
  downloadDirectory: string;
  openUploadSource?: E2bOpenUploadSource;
}
type Actor = "human" | "agent";

function fileIO<A>(operation: () => Promise<A>): Effect.Effect<A, E2bFailure> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => (cause instanceof E2bFailure ? cause : e2bFailure("filePath")),
  });
}

/** On interruption, cancel the cloud reader and join the write loop before the outer scope closes the file. */
function copyCloudDownload(
  stream: ReadableStream<Uint8Array>,
  handle: FileHandle,
  temporary: string,
  target: string,
): Effect.Effect<void, E2bFailure> {
  return Effect.callback<void, E2bFailure>((resume, signal) => {
    const reader = stream.getReader();
    const pending = (async () => {
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          await handle.writeFile(chunk.value, { signal });
        }
        signal.throwIfAborted();
        await handle.sync();
        signal.throwIfAborted();
        await link(temporary, target);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    })();
    pending.then(
      () => resume(Effect.void),
      () => resume(Effect.fail(e2bFailure("filePath"))),
    );
    return Effect.promise(async () => {
      await Promise.allSettled([reader.cancel().catch(() => undefined), pending]);
    });
  });
}

/** Owns cloud-computer lifecycle and control. App shutdown never deletes or silently resumes a VM. */
export class E2bDesktopService {
  readonly #store: E2bDesktopStore;
  readonly #adapter: E2bDesktopAdapterPort;
  readonly #agentExists: (agentId: string) => boolean;
  readonly #workspaceForAgent: (agentId: string) => string | null;
  readonly #downloadDirectory: string;
  readonly #openUploadSource: E2bOpenUploadSource;
  readonly #locks = new Map<string, Semaphore.Semaphore>();
  readonly #takeovers = new Map<string, number>();
  #activeOperations = 0;
  #savingSettings = false;
  #disposed = false;

  constructor({
    store,
    adapter,
    agentExists,
    workspaceForAgent,
    downloadDirectory,
    openUploadSource = openE2bUploadSource,
  }: E2bDesktopServiceOptions) {
    this.#store = store;
    this.#adapter = adapter;
    this.#agentExists = agentExists;
    this.#workspaceForAgent = workspaceForAgent;
    this.#downloadDirectory = downloadDirectory;
    this.#openUploadSource = openUploadSource;
  }

  getSettings() {
    return this.#store.settings();
  }

  list(): E2bMachine[] {
    return this.#store.settings().machines;
  }

  dispose(): Effect.Effect<void, E2bFailure> {
    return Effect.suspend(() => {
      this.#disposed = true;
      return this.#adapter.dispose();
    });
  }

  saveSettings(input: SaveE2bSettingsInput) {
    return Effect.suspend(() => {
      if (this.#activeOperations > 0 || this.#savingSettings) return Effect.fail(e2bFailure("busy"));
      this.#savingSettings = true;
      return Effect.gen({ self: this }, function* () {
        const settings = yield* this.#store.save(input);
        // SDK handles carry credentials. A saved replacement/removal invalidates them too.
        if (input.clearApiKey || input.apiKey?.trim()) yield* this.#adapter.dispose();
        return settings;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#savingSettings = false;
          }),
        ),
      );
    });
  }

  status(agentId: string): Effect.Effect<E2bMachine | null, E2bFailure> {
    return this.#operate(agentId, "human", false, () =>
      Effect.gen({ self: this }, function* () {
        const machine = this.#store.machine(agentId);
        if (!machine) return null;
        const apiKey = yield* this.#store.key();
        const state = yield* this.#adapter.info(apiKey, machine.sandboxId);
        return yield* this.#store.put({ ...machine, state, updatedAt: new Date().toISOString() });
      }),
    );
  }

  start(agentId: string, actor: Actor = "human"): Effect.Effect<E2bMachine, E2bFailure> {
    return this.#operate(agentId, actor, true, () =>
      Effect.gen({ self: this }, function* () {
        const pendingRecovery = actor === "human" && this.#store.settings().pendingAgentIds.includes(agentId);
        if (!this.#agentExists(agentId) && !pendingRecovery) return yield* Effect.fail(e2bFailure("agentMissing"));
        const apiKey = yield* this.#store.key();
        const previous = this.#store.machine(agentId);
        if (previous) {
          if (previous.state === "missing") return yield* Effect.fail(e2bFailure("machineExpired"));
          yield* this.#adapter.connect(apiKey, previous.sandboxId, this.#store.settings().timeoutMinutes);
          return yield* this.#store.put({ ...previous, state: "running", updatedAt: new Date().toISOString() });
        }
        // A stable idempotency key survives network errors and app restarts during creation.
        const creation = yield* this.#store.reserveCreation(agentId);
        const created = yield* Effect.result(this.#adapter.create(apiKey, agentId, creation));
        if (Result.isFailure(created)) {
          if (created.failure.code === "auth" || created.failure.code === "invalidTemplate")
            yield* this.#store.forget(agentId);
          return yield* Effect.fail(created.failure);
        }
        const sandboxId = created.success;
        const machine: E2bMachine = {
          agentId,
          sandboxId,
          state: "running",
          control: "agent",
          createdAt: creation.createdAt,
          updatedAt: new Date().toISOString(),
        };
        const saved = yield* Effect.result(this.#store.put(machine));
        if (Result.isSuccess(saved)) return saved.success;
        const deleted = yield* Effect.result(this.#adapter.delete(apiKey, sandboxId));
        if (Result.isFailure(deleted)) {
          // A failed delete must not turn into an untracked, indefinitely running machine.
          yield* Effect.result(this.#adapter.pause(apiKey, sandboxId));
          return yield* Effect.fail(e2bFailure("createCleanup"));
        }
        yield* Effect.result(this.#store.forget(agentId));
        return yield* Effect.fail(saved.failure);
      }),
    );
  }

  pause(agentId: string, actor: Actor = "human"): Effect.Effect<E2bMachine, E2bFailure> {
    return this.#operate(agentId, actor, true, () =>
      Effect.gen({ self: this }, function* () {
        const machine = yield* this.#machine(agentId);
        const apiKey = yield* this.#store.key();
        yield* this.#adapter.pause(apiKey, machine.sandboxId);
        // A human lease is kept while paused. Resume must not silently hand it back.
        return yield* this.#store.put({ ...machine, state: "paused", updatedAt: new Date().toISOString() });
      }),
    );
  }

  delete(agentId: string, actor: Actor = "human"): Effect.Effect<void, E2bFailure> {
    return this.#operate(agentId, actor, true, () =>
      Effect.gen({ self: this }, function* () {
        const machine = this.#store.machine(agentId);
        if (machine) {
          const apiKey = yield* this.#store.key();
          yield* this.#adapter.delete(apiKey, machine.sandboxId);
        }
        yield* this.#store.forget(agentId);
      }),
    );
  }

  screenshot(agentId: string, actor: Actor = "human"): Effect.Effect<E2bScreenshot, E2bFailure> {
    return this.#operate(agentId, actor, actor === "agent", () =>
      Effect.gen({ self: this }, function* () {
        const machine = yield* this.#running(agentId);
        const bytes = yield* this.#adapter.screenshot(machine.sandboxId);
        return { mimeType: "image/png" as const, base64: Buffer.from(bytes).toString("base64") };
      }),
    );
  }

  execute(agentId: string, command: string, timeoutMs: number) {
    return this.#operate(agentId, "agent", true, () =>
      Effect.gen({ self: this }, function* () {
        const machine = yield* this.#running(agentId, timeoutMs + 15_000);
        return yield* this.#adapter.execute(machine.sandboxId, command, timeoutMs);
      }),
    );
  }

  input(agentId: string, input: E2bDesktopInput) {
    return this.#operate(agentId, "agent", true, () =>
      Effect.gen({ self: this }, function* () {
        const machine = yield* this.#running(agentId);
        yield* this.#adapter.input(machine.sandboxId, input);
      }),
    );
  }

  upload(agentId: string, localPath: string, remotePath: string): Effect.Effect<E2bFileResult, E2bFailure> {
    return this.#operate(
      agentId,
      "agent",
      true,
      () =>
        Effect.gen({ self: this }, function* () {
          const machine = yield* this.#running(agentId);
          const root = yield* this.#workspace(agentId);
          return yield* Effect.acquireUseRelease(
            this.#openUploadSource(root, localPath),
            ({ handle }) =>
              Effect.gen({ self: this }, function* () {
                const info = yield* fileIO(() => handle.stat());
                const stream = handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
                const sourceClosed = finished(stream, { cleanup: true }).catch(() => undefined);
                const cancelSource = async () => {
                  stream.destroy();
                  await sourceClosed;
                };
                yield* this.#adapter
                  .upload(
                    machine.sandboxId,
                    remotePath,
                    stream,
                    this.#store.settings().timeoutMinutes * 60_000,
                    cancelSource,
                  )
                  .pipe(Effect.ensuring(Effect.promise(cancelSource)));
                return { path: remotePath, bytes: info.size };
              }),
            ({ handle }) => Effect.promise(() => handle.close().catch(() => undefined)),
          );
        }),
      true,
    );
  }

  download<A, E>(
    agentId: string,
    remotePath: string,
    fileName: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | E2bFailure> {
    return this.#operate(
      agentId,
      "agent",
      true,
      () =>
        Effect.gen({ self: this }, function* () {
          const machine = yield* this.#running(agentId);
          if (
            fileName !== basename(fileName) ||
            /[\\/\0]/u.test(fileName) ||
            fileName === "." ||
            fileName === ".." ||
            !fileName ||
            fileName.length > 240
          )
            return yield* Effect.fail(e2bFailure("filePath"));
          // A model chooses a file name, never a host directory. Private, unique directories avoid
          // traversing an agent-writable workspace during a cloud download.
          const owner = createHash("sha256").update(agentId).digest("hex");
          const parent = join(this.#downloadDirectory, owner, randomUUID());
          const target = join(parent, fileName);
          const temporary = join(parent, ".partial");
          return yield* Effect.acquireUseRelease(
            fileIO(async () => {
              await mkdir(parent, { recursive: true, mode: 0o700 });
              try {
                return await open(temporary, "wx+", 0o600);
              } catch (cause) {
                await rm(parent, { recursive: true, force: true }).catch(() => undefined);
                throw cause;
              }
            }),
            (handle) =>
              Effect.gen({ self: this }, function* () {
                yield* Effect.acquireUseRelease(
                  this.#adapter
                    .download(machine.sandboxId, remotePath, this.#store.settings().timeoutMinutes * 60_000)
                    .pipe(Effect.interruptible),
                  (stream) => copyCloudDownload(stream, handle, temporary, target),
                  (stream) => Effect.promise(() => stream.cancel().catch(() => undefined)),
                );
                return yield* consume({ path: target, handle });
              }),
            (handle) =>
              Effect.promise(async () => {
                await handle.close().catch(() => undefined);
                await rm(parent, { recursive: true, force: true }).catch(() => undefined);
              }),
          );
        }),
      true,
    );
  }

  takeover(agentId: string): Effect.Effect<{ machine: E2bMachine } & E2bDesktopStream, E2bFailure> {
    // Set the barrier before waiting for the current action. Queued agent actions must not win next.
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        this.#takeovers.set(agentId, (this.#takeovers.get(agentId) ?? 0) + 1);
      }),
      () =>
        this.#operate(agentId, "human", true, () =>
          Effect.gen({ self: this }, function* () {
            const current = yield* this.#machine(agentId);
            const machine = yield* this.#store.put({
              ...current,
              control: "human",
              updatedAt: new Date().toISOString(),
            });
            const apiKey = yield* this.#store.key();
            yield* this.#adapter.connect(apiKey, current.sandboxId, this.#store.settings().timeoutMinutes);
            // Human control remains durable if connecting or stream setup fails.
            const viewer = yield* this.#adapter.startStream(current.sandboxId);
            const running = yield* this.#store.put({
              ...machine,
              state: "running",
              updatedAt: new Date().toISOString(),
            });
            return { machine: running, ...viewer };
          }),
        ),
      () =>
        Effect.sync(() => {
          const remaining = (this.#takeovers.get(agentId) ?? 1) - 1;
          if (remaining === 0) this.#takeovers.delete(agentId);
          else this.#takeovers.set(agentId, remaining);
        }),
    );
  }

  handback(agentId: string): Effect.Effect<E2bMachine, E2bFailure> {
    return this.#operate(agentId, "human", true, () =>
      Effect.gen({ self: this }, function* () {
        const machine = yield* this.#machine(agentId);
        if (machine.control === "agent") return machine;
        const apiKey = yield* this.#store.key();
        const state = yield* this.#adapter.info(apiKey, machine.sandboxId);
        if (state !== "missing") {
          // Paused guests can retain an authenticated VNC process in their memory snapshot.
          // Resume only on this explicit handback, revoke it, then restore the paused state.
          yield* this.#adapter.connect(apiKey, machine.sandboxId, this.#store.settings().timeoutMinutes);
          yield* this.#adapter.stopStream(machine.sandboxId);
          if (state === "paused") yield* this.#adapter.pause(apiKey, machine.sandboxId);
        }
        return yield* this.#store.put({ ...machine, state, control: "agent", updatedAt: new Date().toISOString() });
      }),
    );
  }

  #operate<A, E>(
    agentId: string,
    actor: Actor,
    changes: boolean,
    run: () => Effect.Effect<A, E>,
    interruptible = false,
  ): Effect.Effect<A, E | E2bFailure> {
    return Effect.suspend((): Effect.Effect<A, E | E2bFailure> => {
      if (this.#savingSettings || this.#disposed) return Effect.fail(e2bFailure("busy"));
      this.#activeOperations += 1;
      let lock = this.#locks.get(agentId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        this.#locks.set(agentId, lock);
      }
      return lock
        .withPermit(
          Effect.suspend((): Effect.Effect<A, E | E2bFailure> => {
            if (this.#disposed) return Effect.fail(e2bFailure("busy"));
            const humanControl = this.#store.machine(agentId)?.control === "human" || this.#takeovers.has(agentId);
            if (actor === "agent" && changes && humanControl) return Effect.fail(e2bFailure("humanControl"));
            return run();
          }).pipe(interruptible ? Effect.interruptible : Effect.uninterruptible),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.#activeOperations -= 1;
            }),
          ),
        );
    });
  }

  #machine(agentId: string): Effect.Effect<E2bMachine, E2bFailure> {
    const machine = this.#store.machine(agentId);
    return machine ? Effect.succeed(machine) : Effect.fail(e2bFailure("machineMissing"));
  }

  #running(agentId: string, minimumTimeoutMs = 0): Effect.Effect<E2bMachine, E2bFailure> {
    return this.#machine(agentId).pipe(
      Effect.flatMap((machine) => {
        if (machine.state !== "running") return Effect.fail(e2bFailure("notRunning"));
        const timeoutMs = Math.max(this.#store.settings().timeoutMinutes * 60_000, minimumTimeoutMs);
        return this.#adapter.touch(machine.sandboxId, timeoutMs).pipe(Effect.as(machine));
      }),
    );
  }

  #workspace(agentId: string): Effect.Effect<string, E2bFailure> {
    const path = this.#workspaceForAgent(agentId);
    return path ? fileIO(() => realpath(path)) : Effect.fail(e2bFailure("agentMissing"));
  }
}
