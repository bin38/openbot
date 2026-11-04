import {
  AuthenticationError,
  CommandExitError,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
} from "@e2b/desktop";
import type { E2bCommandResult, E2bDesktopInput, E2bMachine } from "@openbot/contracts/ipc";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { e2bScrollSteps, e2bSupervisedCommand } from "./e2b-command-supervisor";
import { E2bFailure, e2bFailure } from "./e2b-desktop-errors";
import type { E2bCreation } from "./e2b-desktop-store";

/** Viewer credentials stay in main; they are never part of a renderer or model response. */
export interface E2bDesktopStream {
  url: string;
  trafficAccessToken?: string;
}

export interface E2bDesktopAdapterPort {
  create(apiKey: string, agentId: string, creation: E2bCreation): Effect.Effect<string, E2bFailure>;
  connect(apiKey: string, sandboxId: string, timeoutMinutes: number): Effect.Effect<void, E2bFailure>;
  touch(sandboxId: string, timeoutMs: number): Effect.Effect<void, E2bFailure>;
  info(apiKey: string, sandboxId: string): Effect.Effect<E2bMachine["state"], E2bFailure>;
  pause(apiKey: string, sandboxId: string): Effect.Effect<void, E2bFailure>;
  delete(apiKey: string, sandboxId: string): Effect.Effect<void, E2bFailure>;
  screenshot(sandboxId: string): Effect.Effect<Uint8Array, E2bFailure>;
  execute(sandboxId: string, command: string, timeoutMs: number): Effect.Effect<E2bCommandResult, E2bFailure>;
  input(sandboxId: string, input: E2bDesktopInput): Effect.Effect<void, E2bFailure>;
  upload(
    sandboxId: string,
    path: string,
    source: AsyncIterable<Uint8Array>,
    timeoutMs: number,
    cancelSource: () => Promise<void>,
  ): Effect.Effect<void, E2bFailure>;
  download(sandboxId: string, path: string, timeoutMs: number): Effect.Effect<ReadableStream<Uint8Array>, E2bFailure>;
  startStream(sandboxId: string): Effect.Effect<E2bDesktopStream, E2bFailure>;
  stopStream(sandboxId: string): Effect.Effect<void, E2bFailure>;
  dispose(): Effect.Effect<void, E2bFailure>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const OUTPUT_CHARACTERS = 32_768;

function safeFailure(cause: unknown): E2bFailure {
  if (cause instanceof E2bFailure) return cause;
  if (cause instanceof AuthenticationError) return e2bFailure("auth");
  if (cause instanceof RateLimitError) return e2bFailure("rateLimit");
  if (cause instanceof SandboxNotFoundError) return e2bFailure("machineExpired");
  if (cause instanceof SandboxError && cause.statusCode === 403) return e2bFailure("auth");
  return e2bFailure("unavailable");
}

function safeCreationFailure(cause: unknown): E2bFailure {
  if (
    cause instanceof InvalidArgumentError ||
    cause instanceof NotFoundError ||
    (cause instanceof SandboxError && (cause.statusCode === 400 || cause.statusCode === 404))
  )
    return e2bFailure("invalidTemplate");
  return safeFailure(cause);
}

/** The sole E2B SDK owner. A cached handle exists only after an explicit start/resume. */
export class E2bDesktopAdapter implements E2bDesktopAdapterPort {
  readonly #sandboxes = new Map<string, Sandbox>();
  readonly #streams = new Set<string>();

  create(apiKey: string, agentId: string, creation: E2bCreation): Effect.Effect<string, E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        const sandbox = await Sandbox.create(creation.template, {
          apiKey,
          signal,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          timeoutMs: creation.timeoutMinutes * 60_000,
          idempotencyKey: creation.idempotencyKey,
          metadata: { openbotAgentId: agentId },
          lifecycle: { onTimeout: "pause", autoResume: false },
        });
        this.#sandboxes.set(sandbox.sandboxId, sandbox);
        return sandbox.sandboxId;
      },
      catch: safeCreationFailure,
    });
  }

  connect(apiKey: string, sandboxId: string, timeoutMinutes: number): Effect.Effect<void, E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        const sandbox = await Sandbox.connect(sandboxId, {
          apiKey,
          signal,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          timeoutMs: timeoutMinutes * 60_000,
          onResume: "restore",
        });
        this.#sandboxes.set(sandboxId, sandbox);
      },
      catch: safeFailure,
    });
  }

  info(apiKey: string, sandboxId: string): Effect.Effect<E2bMachine["state"], E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        const info = await Sandbox.getInfo(sandboxId, { apiKey, signal, requestTimeoutMs: REQUEST_TIMEOUT_MS });
        return info.state;
      },
      catch: safeFailure,
    }).pipe(
      Effect.catch((failure) =>
        failure.code === "machineExpired" ? Effect.succeed("missing" as const) : Effect.fail(failure),
      ),
    );
  }

  touch(sandboxId: string, timeoutMs: number): Effect.Effect<void, E2bFailure> {
    return this.#operation(sandboxId, (sandbox, signal) =>
      sandbox.setTimeout(timeoutMs, { signal, requestTimeoutMs: REQUEST_TIMEOUT_MS }),
    );
  }

  pause(apiKey: string, sandboxId: string): Effect.Effect<void, E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        await Sandbox.pause(sandboxId, { apiKey, signal, requestTimeoutMs: REQUEST_TIMEOUT_MS });
        this.#sandboxes.delete(sandboxId);
      },
      catch: safeFailure,
    });
  }

  delete(apiKey: string, sandboxId: string): Effect.Effect<void, E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        await Sandbox.kill(sandboxId, { apiKey, signal, requestTimeoutMs: REQUEST_TIMEOUT_MS });
        this.#sandboxes.delete(sandboxId);
      },
      catch: safeFailure,
    }).pipe(Effect.catch((failure) => (failure.code === "machineExpired" ? Effect.void : Effect.fail(failure))));
  }

  screenshot(sandboxId: string): Effect.Effect<Uint8Array, E2bFailure> {
    return this.#operation(sandboxId, (sandbox) => sandbox.screenshot());
  }

  execute(sandboxId: string, command: string, timeoutMs: number): Effect.Effect<E2bCommandResult, E2bFailure> {
    return this.#operation(sandboxId, async (sandbox, signal) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const capture = (target: "stdout" | "stderr", chunk: string) => {
        const current = target === "stdout" ? stdout : stderr;
        const remaining = Math.max(0, OUTPUT_CHARACTERS - current.length);
        if (chunk.length > remaining) truncated = true;
        if (target === "stdout") stdout += chunk.slice(0, remaining);
        else stderr += chunk.slice(0, remaining);
      };
      const boundedCommand = e2bSupervisedCommand(command, timeoutMs);
      let exitCode: number;
      try {
        const result = await sandbox.commands.run(boundedCommand, {
          signal,
          timeoutMs: timeoutMs + 10_000,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          retainOutput: false,
          onStdout: (chunk) => capture("stdout", chunk),
          onStderr: (chunk) => capture("stderr", chunk),
        });
        exitCode = result.exitCode;
      } catch (cause) {
        if (!(cause instanceof CommandExitError)) throw cause;
        exitCode = cause.exitCode;
      }
      return { exitCode, stdout: redactText(stdout), stderr: redactText(stderr), truncated };
    });
  }

  input(sandboxId: string, input: E2bDesktopInput): Effect.Effect<void, E2bFailure> {
    return this.#operation(sandboxId, async (sandbox) => {
      switch (input.kind) {
        case "click":
          if (input.button === "right") await sandbox.rightClick(input.x, input.y);
          else if (input.button === "double") await sandbox.doubleClick(input.x, input.y);
          else await sandbox.leftClick(input.x, input.y);
          break;
        case "type":
          await sandbox.write(input.text, { chunkSize: 256, delayInMs: 0 });
          break;
        case "key":
          await sandbox.press(input.key);
          break;
        case "scroll":
          await sandbox.scroll(input.direction, e2bScrollSteps(input.pixels));
          break;
      }
    });
  }

  upload(
    sandboxId: string,
    path: string,
    source: AsyncIterable<Uint8Array>,
    timeoutMs: number,
    cancelSource: () => Promise<void>,
  ): Effect.Effect<void, E2bFailure> {
    return this.#transfer(
      sandboxId,
      async (sandbox, controller) => {
        const { signal } = controller;
        const renew = this.#transferLease(sandbox, timeoutMs, signal);
        async function* chunks() {
          for await (const chunk of source) {
            signal.throwIfAborted();
            await renew();
            signal.throwIfAborted();
            yield chunk;
          }
        }
        await sandbox.files.write(path, chunks(), { signal, requestTimeoutMs: REQUEST_TIMEOUT_MS });
      },
      cancelSource,
    );
  }

  download(sandboxId: string, path: string, timeoutMs: number): Effect.Effect<ReadableStream<Uint8Array>, E2bFailure> {
    return Effect.suspend(() => {
      let output: ReadableStream<Uint8Array> | null = null;
      return this.#transfer(
        sandboxId,
        async (sandbox, abort) => {
          const { signal } = abort;
          const stream = await sandbox.files.read(path, {
            signal,
            format: "stream",
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
            streamIdleTimeoutMs: REQUEST_TIMEOUT_MS,
          });
          const reader = stream.getReader();
          const renew = this.#transferLease(sandbox, timeoutMs, signal);
          let pulling = Promise.resolve();
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            reader.releaseLock();
          };
          output = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulling = (async () => {
                try {
                  signal.throwIfAborted();
                  const chunk = await reader.read();
                  signal.throwIfAborted();
                  if (chunk.done) {
                    release();
                    controller.close();
                  } else {
                    await renew();
                    signal.throwIfAborted();
                    controller.enqueue(chunk.value);
                  }
                } catch (cause) {
                  await reader.cancel().catch(() => undefined);
                  release();
                  controller.error(safeFailure(cause));
                }
              })();
              return pulling;
            },
            async cancel() {
              abort.abort();
              await reader.cancel().catch(() => undefined);
              await pulling;
              release();
            },
          });
          return output;
        },
        async () => {
          await output?.cancel().catch(() => undefined);
        },
      );
    });
  }

  /** Cancellation joins the SDK promise before a caller can release its file descriptor or lock. */
  #transfer<A>(
    sandboxId: string,
    operation: (sandbox: Sandbox, controller: AbortController) => Promise<A>,
    cancelSource: () => Promise<void>,
  ): Effect.Effect<A, E2bFailure> {
    return Effect.callback<A, E2bFailure>((resume) => {
      const controller = new AbortController();
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        const sandbox = this.#sandboxes.get(sandboxId);
        if (!sandbox) throw e2bFailure("notRunning");
        return operation(sandbox, controller);
      });
      pending.then(
        (value) => resume(Effect.succeed(value)),
        (cause) => resume(Effect.fail(safeFailure(cause))),
      );
      return Effect.promise(async () => {
        controller.abort();
        await Promise.allSettled([cancelSource(), pending]);
        // A response can arrive while cancellation is joining the handshake.
        await cancelSource().catch(() => undefined);
      });
    });
  }

  startStream(sandboxId: string): Effect.Effect<E2bDesktopStream, E2bFailure> {
    return this.#operation(sandboxId, async (sandbox) => {
      // Stop the old VNC process even after app restart. A new start always rotates its password.
      await sandbox.stream.stop();
      this.#streams.add(sandboxId);
      await sandbox.stream.start({ requireAuth: true });
      const authKey = sandbox.stream.getAuthKey();
      registerSecretValue(authKey, { allowShort: true });
      const url = sandbox.stream.getUrl({ authKey, resize: "scale" });
      registerSecretValue(url);
      // Private E2B port traffic needs this token in addition to the VNC password.
      const trafficAccessToken = sandbox.trafficAccessToken;
      if (trafficAccessToken) registerSecretValue(trafficAccessToken);
      return { url, ...(trafficAccessToken ? { trafficAccessToken } : {}) };
    });
  }

  stopStream(sandboxId: string): Effect.Effect<void, E2bFailure> {
    return this.#operation(sandboxId, async (sandbox) => {
      await sandbox.stream.stop();
      this.#streams.delete(sandboxId);
    });
  }

  dispose(): Effect.Effect<void, E2bFailure> {
    return Effect.tryPromise({
      try: async (signal) => {
        const streams = [...this.#streams].flatMap((id) => {
          const sandbox = this.#sandboxes.get(id);
          return sandbox ? [sandbox] : [];
        });
        try {
          // Close the VNC authority with a short shutdown deadline. No VM is resumed, paused or killed.
          const results = await Promise.allSettled(
            streams.map((sandbox) =>
              sandbox.commands.run("pkill -x x11vnc || true", { timeoutMs: 5_000, requestTimeoutMs: 5_000, signal }),
            ),
          );
          if (results.some((result) => result.status === "rejected")) throw e2bFailure("stream");
        } finally {
          this.#streams.clear();
          this.#sandboxes.clear();
        }
      },
      catch: safeFailure,
    });
  }

  #operation<A>(
    sandboxId: string,
    operation: (sandbox: Sandbox, signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, E2bFailure> {
    return Effect.tryPromise({
      try: (signal) => {
        const sandbox = this.#sandboxes.get(sandboxId);
        if (!sandbox) throw e2bFailure("notRunning");
        return operation(sandbox, signal);
      },
      catch: safeFailure,
    });
  }

  #transferLease(sandbox: Sandbox, timeoutMs: number, signal: AbortSignal): () => Promise<void> {
    let renewAfter = Date.now() + timeoutMs / 2;
    return async () => {
      if (Date.now() < renewAfter) return;
      await sandbox.setTimeout(timeoutMs, { signal, requestTimeoutMs: REQUEST_TIMEOUT_MS });
      renewAfter = Date.now() + timeoutMs / 2;
    };
  }
}
