import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  COLAB_LIMITS,
  type ColabCreateInput,
  type ColabExecuteInput,
  type ColabFilesInput,
  type ColabSession,
  type ColabSnapshot,
  isColabSessionName,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger, registerSecretValue, registerSecretValues } from "@openbot/logging";
import { Effect, Result, Semaphore } from "effect";
import type { GeneratedAttachmentSource } from "../backend/attachment-files";
import { colabFailure } from "../backend/colab-errors";
import { geminiProxyEnvironment } from "../backend/gemini-proxy-environment";
import {
  asColabFailure,
  type ColabCli,
  type ColabProcess,
  credentialFilePresent,
  locateColab,
  registerColabSecrets,
  startColabProcess,
} from "./colab-cli";

const logger = createOpenBotLogger("colab");
const LOGIN_TIMEOUT = 5 * 60_000;
const DEFAULT_TIMEOUT = 45_000;

export interface ColabServiceOptions {
  artifactsDirectory: string;
  /** Tests use their own executable and HOME; production uses the installed official CLI. */
  executable?: string;
  homeDirectory?: string;
  proxySettings?: () => { enabled: boolean; proxyUrl: string };
}

function validRemotePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= COLAB_LIMITS.path &&
    !/\p{Cc}/u.test(value) &&
    !value.startsWith("-") &&
    !value.split(/[\\/]/u).includes("..")
  );
}

function sessionsFromText(text: string): { sessions: ColabSession[]; unmanaged: number } {
  const sessions: ColabSession[] = [];
  let unmanaged = 0;
  for (const line of text.split("\n")) {
    const match =
      /^\[([^\]]+)\]\s+\S+\s*\|\s*Hardware:\s*([^|]+)\|\s*Shape:\s*([^|]+)\|\s*Variant:\s*([^|]+)(?:\|\s*Status:\s*(.*))?$/u.exec(
        line.trim(),
      );
    if (!match) {
      if (line.includes(" | Hardware:")) unmanaged += 1;
      continue;
    }
    const name = match[1];
    if (name === "?") {
      unmanaged += 1;
      continue;
    }
    if (!isColabSessionName(name)) {
      unmanaged += 1;
      continue;
    }
    if (sessions.some((row) => row.name === name) || sessions.length >= 256) continue;
    sessions.push({
      name,
      hardware: (match[2] ?? "CPU").trim().slice(0, 128),
      shape: (match[3] ?? "").trim().slice(0, 128),
      state: match[5]?.startsWith("BUSY") ? "busy" : match[5]?.startsWith("IDLE") ? "idle" : "unknown",
    });
  }
  return { sessions, unmanaged };
}

/** Owns Colab CLI processes and transient artifacts. Google credentials remain in the CLI's store. */
export class ColabService {
  readonly #home: string;
  readonly #active = new Map<ChildProcessWithoutNullStreams, ColabProcess>();
  #cli: ColabCli | null = null;
  #sessions: ColabSession[] = [];
  #unmanaged = 0;
  #connected = false;
  #refreshedAt: number | null = null;
  #loginPhase: ColabSnapshot["loginPhase"] = "idle";
  #message: string | null = null;
  #login: ColabProcess | null = null;
  #loginSettled: Promise<void> | null = null;
  #loginUrl: string | null = null;
  #automaticAuthorizationOpened = false;
  #loginRevision = 0;
  #closed = false;
  readonly #creations = Semaphore.makeUnsafe(1);

  constructor(private readonly options: ColabServiceOptions) {
    this.#home = options.homeDirectory ?? homedir();
  }

  #environment(network: boolean): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TEMP",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "LANG",
      "LC_ALL",
      "TZ",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "REQUESTS_CA_BUNDLE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      if (process.env[name] !== undefined) result[name] = process.env[name];
    }
    result.HOME = this.#home;
    result.PYTHONUNBUFFERED = "1";
    result.NO_COLOR = "1";
    result.TERM = "dumb";
    result.COLUMNS = "240";
    if (network && this.options.proxySettings)
      Object.assign(result, geminiProxyEnvironment(this.options.proxySettings()));
    return result;
  }

  #track(process: ColabProcess): ColabProcess {
    this.#active.set(process.child, process);
    void process.done.then(
      () => this.#active.delete(process.child),
      () => this.#active.delete(process.child),
    );
    return process;
  }

  #start(options: Parameters<typeof startColabProcess>[0]): ColabProcess {
    if (this.#closed) throw colabFailure("cancelled");
    return this.#track(startColabProcess(options));
  }

  readonly #process = Effect.fn("Colab.process")(function* (
    this: ColabService,
    options: Parameters<typeof startColabProcess>[0],
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => this.#start(options), catch: asColabFailure }),
      (operation) => Effect.tryPromise({ try: () => operation.done, catch: asColabFailure }),
      (operation) =>
        Effect.promise(async () => {
          if (operation.child.exitCode === null && operation.child.signalCode === null) operation.stop();
          await operation.done.then(
            () => undefined,
            () => undefined,
          );
        }),
    );
  });

  readonly #detect = Effect.fn("Colab.detect")(function* (this: ColabService) {
    if (this.#cli) return this.#cli;
    const found = yield* Effect.tryPromise({ try: () => locateColab(this.options.executable), catch: asColabFailure });
    if (!found) return null;
    const result = yield* this.#process({
      cli: found,
      args: ["version"],
      environment: this.#environment(false),
      timeoutMs: 10_000,
    });
    const version = /\bVersion:\s*(\d+\.\d+\.\d+(?:[.+-][\w.-]{1,64})?)(?:\s|$)/u.exec(result.text)?.[1];
    if (!version) return null;
    this.#cli = { ...found, version };
    return this.#cli;
  });

  readonly getStatus = Effect.fn("Colab.getStatus")(function* (this: ColabService) {
    const cli = yield* this.#detect();
    const credentialsPresent = yield* Effect.tryPromise({
      try: () => credentialFilePresent(this.#home),
      catch: asColabFailure,
    });
    return {
      installed: cli !== null,
      cliPath: cli?.executable ?? null,
      version: cli?.version ?? null,
      credentialsPresent,
      connected: this.#connected,
      loginPhase: this.#loginPhase,
      canOpenAuthorization: this.#loginUrl !== null,
      message: this.#message,
      sessions: this.#sessions.map((session) => ({ ...session })),
      unmanagedSessions: this.#unmanaged,
      refreshedAt: this.#refreshedAt,
    } satisfies ColabSnapshot;
  });

  readonly #run = Effect.fn("Colab.run")(function* (
    this: ColabService,
    args: string[],
    input?: string,
    timeoutMs = DEFAULT_TIMEOUT,
  ) {
    const cli = yield* this.#detect();
    if (!cli) return yield* colabFailure("missing");
    if (!(yield* Effect.tryPromise({ try: () => credentialFilePresent(this.#home), catch: asColabFailure })))
      return yield* colabFailure("authRequired");
    if (this.#login) return yield* colabFailure("loginPending");
    const environment = yield* Effect.try({ try: () => this.#environment(true), catch: asColabFailure });
    return yield* this.#process({
      cli,
      args,
      environment,
      timeoutMs,
      ...(input === undefined ? {} : { input }),
      beforeResult: () => registerColabSecrets(this.#home, registerSecretValues),
    });
  });

  readonly refresh = Effect.fn("Colab.refresh")(function* (this: ColabService) {
    const result = yield* Effect.result(this.#run(["sessions"]));
    if (Result.isFailure(result)) {
      this.#connected = false;
      this.#message = result.failure.message;
      return yield* result.failure;
    }
    const parsed = sessionsFromText(result.success.text);
    this.#sessions = parsed.sessions;
    this.#unmanaged = parsed.unmanaged;
    this.#connected = true;
    this.#refreshedAt = Date.now();
    this.#message = null;
    return yield* this.getStatus();
  });

  /** The CLI's read-only session listing triggers its official login, never a VM allocation. */
  readonly startLogin = Effect.fn("Colab.startLogin")(function* (this: ColabService) {
    if (this.#login) return yield* this.getStatus();
    const enteredRevision = this.#loginRevision;
    const cli = yield* this.#detect();
    if (!cli) return yield* colabFailure("missing");
    // Detection is asynchronous. A concurrent login or cancel can take ownership while it runs.
    if (enteredRevision !== this.#loginRevision || this.#login) return yield* this.getStatus();
    const revision = ++this.#loginRevision;
    this.#automaticAuthorizationOpened = false;
    this.#message = null;
    this.#loginPhase = "submitting";
    let ready: () => void = () => {};
    const pending = new Promise<void>((done) => {
      ready = done;
    });
    const operation = yield* Effect.try({
      try: () =>
        this.#start({
          cli,
          args: ["sessions"],
          environment: this.#environment(true),
          timeoutMs: LOGIN_TIMEOUT,
          interactive: true,
          beforeResult: () => registerColabSecrets(this.#home, registerSecretValues),
          onAuthorization: (url) => {
            if (revision !== this.#loginRevision) return;
            this.#loginUrl = url;
            this.#loginPhase = "waiting-code";
            ready();
          },
        }),
      catch: asColabFailure,
    });
    this.#login = operation;
    this.#loginSettled = operation.done
      .then(async (result) => {
        if (revision !== this.#loginRevision) return;
        if (!(await credentialFilePresent(this.#home))) throw colabFailure("loginFailed");
        const parsed = sessionsFromText(result.text);
        this.#sessions = parsed.sessions;
        this.#unmanaged = parsed.unmanaged;
        this.#connected = true;
        this.#refreshedAt = Date.now();
        this.#loginPhase = "connected";
        this.#message = null;
      })
      .catch((failure) => {
        if (revision !== this.#loginRevision) return;
        this.#loginPhase = "error";
        this.#message = asColabFailure(failure).message;
      })
      .finally(() => {
        if (revision === this.#loginRevision) {
          this.#login = null;
          this.#loginUrl = null;
        }
        ready();
      });
    yield* Effect.tryPromise({ try: () => pending, catch: asColabFailure });
    return yield* this.getStatus();
  });

  authorizationUrl(): string {
    if (!this.#loginUrl || this.#loginPhase !== "waiting-code") throw colabFailure("loginPending");
    return this.#loginUrl;
  }

  /** Concurrent Login requests share one browser opening; the explicit reopen action stays available. */
  takeAutomaticAuthorizationUrl(): string | null {
    if (this.#automaticAuthorizationOpened || !this.#loginUrl || this.#loginPhase !== "waiting-code") return null;
    this.#automaticAuthorizationOpened = true;
    return this.#loginUrl;
  }

  readonly submitLoginCode = Effect.fn("Colab.submitLoginCode")(function* (this: ColabService, code: string) {
    const normalized = code.trim();
    if (normalized.length < 8 || normalized.length > 8_192 || /\s|\p{Cc}/u.test(normalized))
      return yield* colabFailure("invalid");
    if (!this.#login || this.#loginPhase !== "waiting-code") return yield* colabFailure("loginPending");
    registerSecretValue(normalized);
    this.#loginPhase = "submitting";
    const operation = this.#login;
    const completion = this.#loginSettled;
    operation.child.stdin.end(`${normalized}\n`);
    if (completion) yield* Effect.tryPromise({ try: () => completion, catch: asColabFailure });
    return yield* this.getStatus();
  });

  readonly cancelLogin = Effect.fn("Colab.cancelLogin")(function* (this: ColabService) {
    const operation = this.#login;
    this.#loginRevision += 1;
    this.#login = null;
    this.#loginUrl = null;
    this.#loginPhase = "idle";
    this.#message = null;
    if (operation) {
      operation.stop();
      yield* Effect.promise(() =>
        operation.done.then(
          () => undefined,
          () => undefined,
        ),
      );
    }
    this.#loginSettled = null;
    return yield* this.getStatus();
  });

  readonly createCpu = Effect.fn("Colab.createCpu")(function* (this: ColabService, input: ColabCreateInput) {
    const name = input.name ?? `openbot-${randomUUID().slice(0, 8)}`;
    if (!isColabSessionName(name)) return yield* colabFailure("invalid");
    return yield* this.#creations.withPermit(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.refresh();
        if (current.sessions.some((session) => session.name === name)) return current;
        yield* this.#run(["new", "--session", name]);
        return yield* this.refresh();
      }),
    );
  });

  readonly execute = Effect.fn("Colab.execute")(function* (this: ColabService, input: ColabExecuteInput) {
    const seconds = input.timeoutSeconds ?? 30;
    if (
      !isColabSessionName(input.session) ||
      !input.code.trim() ||
      input.code.length > COLAB_LIMITS.code ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > COLAB_LIMITS.timeoutSeconds
    )
      return yield* colabFailure("invalid");
    return yield* this.#run(
      ["exec", "--session", input.session, "--timeout", String(seconds)],
      input.code,
      seconds * 1_000 + 15_000,
    );
  });

  readonly stop = Effect.fn("Colab.stop")(function* (this: ColabService, session: string) {
    if (!isColabSessionName(session)) return yield* colabFailure("invalid");
    yield* this.#run(["stop", "--session", session]);
    return yield* this.refresh();
  });

  readonly listFiles = Effect.fn("Colab.listFiles")(function* (this: ColabService, input: ColabFilesInput) {
    if (!isColabSessionName(input.session) || !validRemotePath(input.path)) return yield* colabFailure("invalid");
    return yield* this.#run(["ls", "--session", input.session, input.path]);
  });

  readonly sessionUrl = Effect.fn("Colab.sessionUrl")(function* (this: ColabService, session: string) {
    if (!isColabSessionName(session)) return yield* colabFailure("invalid");
    const result = yield* this.#run(["url", "--session", session]);
    return yield* Effect.try({
      try: () => {
        const url = new URL(result.text.trim());
        if (
          url.protocol !== "https:" ||
          url.hostname !== "colab.research.google.com" ||
          url.username ||
          url.password ||
          url.pathname !== "/notebooks/empty.ipynb" ||
          [...url.searchParams.keys()].some((key) => key !== "dbu") ||
          !/^\/tun\/m\/[A-Za-z0-9_-]+$/u.test(url.searchParams.get("dbu") ?? "") ||
          !/^#datalabBackendUrl=https:\/\/colab\.research\.google\.com\/tun\/m\/[A-Za-z0-9_-]+$/u.test(url.hash)
        )
          throw colabFailure("invalid");
        return url.href;
      },
      catch: asColabFailure,
    });
  });

  readonly #temporary = Effect.fn("Colab.temporary")(function* (this: ColabService) {
    return yield* Effect.tryPromise({
      try: async () => {
        await mkdir(this.options.artifactsDirectory, { recursive: true, mode: 0o700 });
        return mkdtemp(join(this.options.artifactsDirectory, "operation-"));
      },
      catch: asColabFailure,
    });
  });

  /** The caller opens the source under its workspace policy and retains ownership of its handle. */
  readonly uploadSource = Effect.fn("Colab.uploadSource")(function* (
    this: ColabService,
    session: string,
    remotePath: string,
    source: GeneratedAttachmentSource,
  ) {
    if (!isColabSessionName(session) || !validRemotePath(remotePath)) return yield* colabFailure("invalid");
    return yield* Effect.acquireUseRelease(
      this.#temporary(),
      (directory) =>
        Effect.gen({ self: this }, function* () {
          const local = join(directory, "input");
          yield* Effect.tryPromise({
            try: (signal) =>
              pipeline(
                source.handle.createReadStream({ autoClose: false, start: 0 }),
                createWriteStream(local, { flags: "wx", mode: 0o600 }),
                { signal },
              ),
            catch: () => colabFailure("file"),
          });
          yield* this.#run(["upload", "--session", session, local, remotePath]);
          const info = yield* Effect.tryPromise({ try: () => source.handle.stat(), catch: () => colabFailure("file") });
          return { remotePath, bytes: info.size };
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });

  readonly executeNotebookSource = Effect.fn("Colab.executeNotebookSource")(function* (
    this: ColabService,
    session: string,
    source: GeneratedAttachmentSource,
    timeoutSeconds = 60,
  ) {
    if (
      !isColabSessionName(session) ||
      extname(source.path).toLowerCase() !== ".ipynb" ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > COLAB_LIMITS.timeoutSeconds
    )
      return yield* colabFailure("invalid");
    return yield* Effect.acquireUseRelease(
      this.#temporary(),
      (directory) =>
        Effect.gen({ self: this }, function* () {
          const local = join(directory, "notebook.ipynb");
          yield* Effect.tryPromise({
            try: (signal) =>
              pipeline(
                source.handle.createReadStream({ autoClose: false, start: 0 }),
                createWriteStream(local, { flags: "wx", mode: 0o600 }),
                { signal },
              ),
            catch: () => colabFailure("file"),
          });
          return yield* this.#run(
            ["exec", "--session", session, "--file", local, "--timeout", String(timeoutSeconds)],
            undefined,
            timeoutSeconds * 1_000 + 15_000,
          );
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });

  readonly download = Effect.fn("Colab.download")(function* <A, E>(
    this: ColabService,
    session: string,
    remotePath: string,
    fileName: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ) {
    if (
      !isColabSessionName(session) ||
      !validRemotePath(remotePath) ||
      !fileName ||
      fileName === "." ||
      fileName === ".." ||
      fileName.includes("\\") ||
      basename(fileName) !== fileName ||
      fileName.length > 255 ||
      /\p{Cc}/u.test(fileName)
    )
      return yield* colabFailure("invalid");
    return yield* Effect.acquireUseRelease(
      this.#temporary(),
      (directory) =>
        Effect.gen({ self: this }, function* () {
          const local = join(directory, fileName);
          yield* this.#run(["download", "--session", session, remotePath, local]);
          return yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => open(local, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
              catch: () => colabFailure("file"),
            }),
            (handle) =>
              Effect.gen(function* () {
                if (
                  !(yield* Effect.tryPromise({ try: () => handle.stat(), catch: () => colabFailure("file") })).isFile()
                )
                  return yield* colabFailure("file");
                return yield* consume({ path: local, handle });
              }),
            (handle) => Effect.promise(() => handle.close()),
          );
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });

  readonly close = Effect.fn("Colab.close")(function* (this: ColabService) {
    this.#closed = true;
    this.#loginRevision += 1;
    this.#loginUrl = null;
    this.#login = null;
    const active = [...this.#active.entries()];
    for (const [, operation] of active) operation.stop();
    yield* Effect.promise(() => Promise.allSettled(active.map(([, operation]) => operation.done)));
    logger.info("Colab CLI processes stopped.");
  });
}
