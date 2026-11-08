import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { COLAB_LIMITS, type ColabCommandResult } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { ColabFailure, colabFailure } from "../backend/colab-errors";

export interface ColabCli {
  executable: string;
  python: string | null;
  version: string;
}

export interface ColabProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<ColabCommandResult>;
  stop(): void;
}

/** Invoke the official package entrypoint with logging disabled, so its debug log cannot record runtime-token URLs. */
const PYTHON_ENTRY =
  "import logging, os; logging.disable(logging.CRITICAL); os.umask(0o077); from colab_cli.cli import main; main()";

export async function locateColab(executable?: string): Promise<{ executable: string; python: string | null } | null> {
  const candidates = executable
    ? [executable]
    : [
        join(homedir(), ".local", "bin", "colab"),
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((path) => join(path, process.platform === "win32" ? "colab.exe" : "colab")),
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const python = join(dirname(resolved), process.platform === "win32" ? "python.exe" : "python");
      if (
        resolved.includes(
          `${process.platform === "win32" ? "\\" : "/"}google-colab-cli${process.platform === "win32" ? "\\" : "/"}`,
        )
      ) {
        await access(python, constants.X_OK);
        return { executable: candidate, python };
      }
      if (executable) return { executable: candidate, python: null };
    } catch {
      /* Try another installed CLI entry. */
    }
  }
  return null;
}

function authorizationUrl(output: string): string | null {
  if (!output.includes("To authorize colab-cli, visit this URL")) return null;
  for (const match of output.matchAll(/https:\/\/accounts\.google\.com\/[^\s<>"']+(?=[\t \r\n])/gu)) {
    try {
      const url = new URL(match[0]);
      if (
        url.hostname === "accounts.google.com" &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        ["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) &&
        url.searchParams.get("response_type") === "code" &&
        url.searchParams.get("client_id") &&
        url.searchParams.get("state") &&
        ![...url.searchParams.keys()].some((key) => /^(?:code|access_token|refresh_token|client_secret)$/u.test(key)) &&
        url.searchParams.get("redirect_uri") === "https://sdk.cloud.google.com/applicationdefaultauthcode.html"
      )
        return url.href;
    } catch {
      /* A fragmented URL can be completed by the next output chunk. */
    }
  }
  return null;
}

export function startColabProcess(options: {
  cli: Pick<ColabCli, "executable" | "python">;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  interactive?: boolean;
  input?: string;
  signal?: AbortSignal;
  beforeResult?: () => Promise<void>;
  onAuthorization?: (url: string) => void;
  onStarted?: (child: ChildProcessWithoutNullStreams) => void;
}): ColabProcess {
  const command = options.cli.python ?? options.cli.executable;
  const args = options.cli.python ? ["-I", "-c", PYTHON_ENTRY, ...options.args] : options.args;
  const child = spawn(command, args, { env: options.environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  options.onStarted?.(child);
  let requestedStop = false;
  let timedOut = false;
  let authRequired = false;
  let authorizationReported = false;
  let inputFailed = false;
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  const stop = () => {
    requestedStop = true;
    child.kill("SIGTERM");
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
    killTimer();
  }, options.timeoutMs);
  deadline.unref();
  const killTimer = () => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  };
  child.stdin.on("error", () => {
    inputFailed = true;
    child.kill("SIGTERM");
    killTimer();
  });
  child.once("spawn", () => {
    if (options.input !== undefined) child.stdin.end(options.input);
    else if (!options.interactive) child.stdin.end();
  });
  const collect = (chunk: Buffer, error: boolean) => {
    const text = chunk.toString("utf8");
    if (error) {
      if (stderrBytes < COLAB_LIMITS.output) stderr += text.slice(0, COLAB_LIMITS.output - stderrBytes);
      stderrBytes += chunk.byteLength;
    } else {
      if (stdoutBytes < COLAB_LIMITS.output) stdout += text.slice(0, COLAB_LIMITS.output - stdoutBytes);
      stdoutBytes += chunk.byteLength;
    }
    truncated ||= stdoutBytes > COLAB_LIMITS.output || stderrBytes > COLAB_LIMITS.output;
    const url = authorizationReported ? null : (authorizationUrl(stderr) ?? authorizationUrl(stdout));
    if (url) {
      authorizationReported = true;
      if (options.onAuthorization) options.onAuthorization(url);
      else {
        authRequired = true;
        stop();
        killTimer();
      }
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
  const abort = () => {
    stop();
    killTimer();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const done = new Promise<ColabCommandResult>((resolve, reject) => {
    child.once("error", () => reject(colabFailure("missing")));
    child.once("close", (code) => {
      void (async () => {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        await options.beforeResult?.();
        if (authRequired) return reject(colabFailure("authRequired"));
        if (timedOut) return reject(colabFailure("timeout"));
        if (requestedStop) return reject(colabFailure("cancelled"));
        if (inputFailed) return reject(colabFailure(options.interactive ? "loginFailed" : "commandFailed"));
        if (code !== 0) {
          const reason = stripVTControlCharacters(`${stderr}\n${stdout}`);
          if (/Session '[^'\n]{1,128}' not found/u.test(reason)) return reject(colabFailure("sessionMissing"));
          if (/\[colab\] Allocation refused \(precondition failed\)/u.test(reason))
            return reject(colabFailure("allocation"));
          if (
            /requests\.exceptions\.ProxyError|urllib3\.exceptions\.ProxyError|Cannot connect to proxy|Unable to connect to proxy/u.test(
              reason,
            )
          )
            return reject(colabFailure("proxy"));
          return reject(colabFailure(options.interactive ? "loginFailed" : "commandFailed"));
        }
        resolve({ text: redactText(stripVTControlCharacters(stdout)).slice(0, COLAB_LIMITS.output), truncated });
      })().catch((error) => reject(asColabFailure(error)));
    });
  });
  return {
    child,
    done,
    stop: () => {
      stop();
      killTimer();
    },
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Only the official current-user cache files may have their permissions tightened. */
export async function secureColabCache(home: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  try {
    const base = await realpath(home);
    const parents: Array<{ path: string; identity: Stats }> = [];
    for (const path of [join(base, ".config"), join(base, ".config", "colab-cli")]) {
      let identity: Stats;
      try {
        identity = await lstat(path);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!identity.isDirectory() || identity.uid !== uid || (identity.mode & 0o022) !== 0)
        throw colabFailure("cacheUnsafe");
      parents.push({ path, identity });
    }
    const checkParents = async () => {
      for (const parent of parents) {
        const current = await lstat(parent.path);
        if (
          !current.isDirectory() ||
          current.uid !== uid ||
          (current.mode & 0o022) !== 0 ||
          current.dev !== parent.identity.dev ||
          current.ino !== parent.identity.ino
        )
          throw colabFailure("cacheUnsafe");
      }
    };
    for (const file of ["token.json", "sessions.json"]) {
      const path = join(base, ".config", "colab-cli", file);
      await checkParents();
      let identity: Stats;
      try {
        identity = await lstat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!identity.isFile() || identity.uid !== uid || identity.nlink !== 1) throw colabFailure("cacheUnsafe");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (
          !current.isFile() ||
          current.uid !== uid ||
          current.nlink !== 1 ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          throw colabFailure("cacheUnsafe");
        await checkParents();
        const named = await lstat(path);
        if (!named.isFile() || named.dev !== current.dev || named.ino !== current.ino)
          throw colabFailure("cacheUnsafe");
        if ((current.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
  } catch {
    throw colabFailure("cacheUnsafe");
  }
}

export async function credentialFilePresent(home = homedir()): Promise<boolean> {
  await secureColabCache(home);
  try {
    await access(join(home, ".config", "colab-cli", "token.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Register only known authentication fields; no token or credential object is returned. */
export async function registerColabSecrets(home: string, register: (values: string[]) => void): Promise<void> {
  await secureColabCache(home);
  for (const file of ["token.json", "sessions.json"]) {
    try {
      const path = join(home, ".config", "colab-cli", file);
      if ((await stat(path)).size > 4_194_304) continue;
      const text = await readFile(path, "utf8");
      const secrets: string[] = [];
      const visit = (input: unknown, depth: number): void => {
        if (depth > 8 || input === null || typeof input !== "object") return;
        for (const [key, item] of Object.entries(input)) {
          if (
            typeof item === "string" &&
            /^(?:token|access_token|refresh_token|id_token|runtime_proxy_token|client_secret|password)$/iu.test(key)
          )
            secrets.push(item);
          else visit(item, depth + 1);
        }
      };
      visit(JSON.parse(text), 0);
      register(secrets);
    } catch {
      /* Missing or unreadable CLI credentials never become diagnostics. */
    }
  }
}

export function asColabFailure(error: unknown): ColabFailure {
  return error instanceof ColabFailure ? error : colabFailure("commandFailed");
}
