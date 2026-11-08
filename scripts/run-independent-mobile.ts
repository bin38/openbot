import { type ChildProcess, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fileConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpenBotLogger, registerSecretValues } from "@openbot/logging";
import { z } from "zod";
import { setDevelopmentOverrides } from "./development-secrets";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relativeDirectory = ".openbot/cloudflare";
const relativeConfig = `${relativeDirectory}/mobile-config.json`;
const relativeSecrets = `${relativeDirectory}/mobile-secrets.sealed.json`;
const logger = createOpenBotLogger("independent-mobile");
const base64 = z
  .string()
  .min(1)
  .max(2_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const envelopeSchema = z.object({ iv: base64, key: base64, payload: base64 });
const secretsSchema = z.object({
  version: z.literal(1),
  ticketPrivateJwk: z.string().min(1).max(16_384),
  ticketPublicJwks: z.string().min(1).max(16_384),
  authWebhookSecret: z.string().min(32).max(256),
  sessionSecret: z.string().min(32).max(256),
});
const configSchema = z.object({
  version: z.literal(1),
  accountUrl: z.url(),
  signalUrl: z.url(),
  signalPort: z.int().min(1_024).max(65_535),
  healthPort: z.int().min(1_024).max(65_535),
  ticketKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  ticketPublicJwks: z.string().min(1).max(16_384),
  secretsFile: z.literal(relativeSecrets),
  turnKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  tunnelId: z.uuid(),
});
const turnResourceSchema = z.object({ uid: z.string(), secret: z.string().min(1).max(16_384) });
const tunnelResourceSchema = z.object({ id: z.string(), token: z.string().min(1).max(32_768) });
const resourcesSchema = z.object({
  accountDomain: z.hostname(),
  signalDomain: z.hostname(),
  localSignalPort: z.int().min(1_024).max(65_535).default(18_081),
  localHealthPort: z.int().min(1_024).max(65_535).default(18_080),
  ticketKeyId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .default("openbot-ily-1"),
  turnKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  tunnelId: z.uuid(),
});
const launcherChildSchema = z.object({ component: z.enum(["signal", "tunnel"]), pid: z.int().min(2) });
const launcherLockSchema = z.object({
  launcherPid: z.int().min(2),
  startedAt: z.iso.datetime(),
  projectRoot: z.string(),
  children: z.array(launcherChildSchema).max(2).default([]),
  released: z.boolean().default(false),
});
type LauncherLockRecord = z.infer<typeof launcherLockSchema>;
type MobileComponent = z.infer<typeof launcherChildSchema>["component"];
const jwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string(),
  y: z.string(),
  d: z.string(),
  kid: z.string(),
});
const jwksSchema = z.object({
  keys: z
    .array(z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string(), kid: z.string() }))
    .length(1),
});

export type IndependentMobileConfiguration = z.infer<typeof configSchema>;
export type IndependentMobileSecrets = z.infer<typeof secretsSchema>;
type SealedEnvelope = z.infer<typeof envelopeSchema>;

class MobileLauncherError extends Error {}

function fail(): never {
  throw new MobileLauncherError(
    "Local mobile connection setup failed. Check the private configuration and service prerequisites.",
  );
}

function ensureDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail();
  if (process.getuid && stat.uid !== process.getuid()) fail();
}

function privateFile(path: string): Buffer {
  const descriptor = openSync(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 2_000_000 || (stat.mode & 0o077) !== 0) fail();
    if (process.getuid && stat.uid !== process.getuid()) fail();
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function privateDirectory(projectRoot: string) {
  ensureDirectory(join(projectRoot, ".openbot"));
  const directory = join(projectRoot, relativeDirectory);
  ensureDirectory(directory);
  return directory;
}

/** Public deployment metadata can be readable, but cannot redirect through a symlink. */
function readResources(directory: string) {
  const descriptor = openSync(join(directory, "resources.json"), fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65_536 || (process.getuid && stat.uid !== process.getuid())) fail();
    return resourcesSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Publish once without replacing a previous identity, including a concurrent prepare. */
function writeOnce(path: string, value: string): void {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (!isExisting(error)) throw error;
  } finally {
    unlinkSync(temporary);
  }
}

function decodeEnvelope<T>(path: string, privateKey: Buffer, schema: z.ZodType<T>): T {
  const envelope = envelopeSchema.parse(JSON.parse(privateFile(path).toString("utf8")));
  const iv = Buffer.from(envelope.iv, "base64");
  const payload = Buffer.from(envelope.payload, "base64");
  if (iv.length !== 12 || payload.length < 17) fail();
  const key = privateDecrypt(
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope.key, "base64"),
  );
  try {
    if (key.length !== 32) fail();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(payload.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
    try {
      return schema.parse(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

function encodeEnvelope(value: IndependentMobileSecrets, privateKey: Buffer): SealedEnvelope {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const payload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const wrapped = publicEncrypt(
      { key: createPublicKey(privateKey), padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      key,
    );
    return { iv: iv.toString("base64"), key: wrapped.toString("base64"), payload: payload.toString("base64") };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function validateSecrets(secrets: IndependentMobileSecrets, keyId: string) {
  const jwk = jwkSchema.parse(JSON.parse(secrets.ticketPrivateJwk));
  const publicJwk = jwksSchema.parse(JSON.parse(secrets.ticketPublicJwks)).keys[0];
  const derived = createPublicKey(createPrivateKey({ key: jwk, format: "jwk" })).export({ format: "jwk" });
  if (
    !publicJwk ||
    jwk.kid !== keyId ||
    publicJwk.kid !== keyId ||
    publicJwk.x !== derived.x ||
    publicJwk.y !== derived.y
  )
    fail();
  registerSecretValues([secrets.ticketPrivateJwk, jwk.d, secrets.authWebhookSecret, secrets.sessionSecret]);
}

function validateConfig(config: IndependentMobileConfiguration) {
  const account = new URL(config.accountUrl);
  const signal = new URL(config.signalUrl);
  if (account.protocol !== "https:" || account.origin !== config.accountUrl || account.username || account.password)
    fail();
  if (
    signal.protocol !== "wss:" ||
    signal.pathname !== "/v1/signal" ||
    signal.username ||
    signal.password ||
    signal.search ||
    signal.hash
  )
    fail();
  for (const url of [account, signal]) {
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (["openbot.run", "openbot.site"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)))
      fail();
  }
  if (config.signalPort === config.healthPort) fail();
}

/** Returns sensitive values only to an explicit in-process caller, never through the CLI. */
export function loadIndependentMobileSecrets(projectRoot = projectDirectory): IndependentMobileSecrets {
  try {
    const directory = privateDirectory(projectRoot);
    const config = configSchema.parse(JSON.parse(privateFile(join(projectRoot, relativeConfig)).toString("utf8")));
    validateConfig(config);
    const privateKey = privateFile(join(directory, "transfer-private.pem"));
    try {
      const secrets = decodeEnvelope(join(projectRoot, config.secretsFile), privateKey, secretsSchema);
      validateSecrets(secrets, config.ticketKeyId);
      if (secrets.ticketPublicJwks !== config.ticketPublicJwks) fail();
      return secrets;
    } finally {
      privateKey.fill(0);
    }
  } catch {
    return fail();
  }
}

/** Generates a separate identity once. Existing development and production identities stay untouched. */
export function prepareIndependentMobile(projectRoot = projectDirectory): IndependentMobileConfiguration {
  try {
    const directory = privateDirectory(projectRoot);
    const resources = readResources(directory);
    const configFile = join(projectRoot, relativeConfig);
    const secretsFile = join(projectRoot, relativeSecrets);
    if (!existsSync(configFile)) {
      const privateKey = privateFile(join(directory, "transfer-private.pem"));
      try {
        const ticketKeyId = resources.ticketKeyId;
        if (!existsSync(secretsFile)) {
          const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
          const secrets: IndependentMobileSecrets = {
            version: 1,
            ticketPrivateJwk: JSON.stringify({
              ...keys.privateKey.export({ format: "jwk" }),
              kid: ticketKeyId,
              alg: "ES256",
              use: "sig",
            }),
            ticketPublicJwks: JSON.stringify({
              keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: ticketKeyId, alg: "ES256", use: "sig" }],
            }),
            authWebhookSecret: randomBytes(32).toString("hex"),
            sessionSecret: randomBytes(32).toString("hex"),
          };
          validateSecrets(secrets, ticketKeyId);
          writeOnce(secretsFile, `${JSON.stringify(encodeEnvelope(secrets, privateKey))}\n`);
        }
        const secrets = decodeEnvelope(secretsFile, privateKey, secretsSchema);
        validateSecrets(secrets, ticketKeyId);
        const config: IndependentMobileConfiguration = {
          version: 1,
          accountUrl: `https://${resources.accountDomain}`,
          signalUrl: `wss://${resources.signalDomain}/v1/signal`,
          signalPort: resources.localSignalPort,
          healthPort: resources.localHealthPort,
          ticketKeyId,
          ticketPublicJwks: secrets.ticketPublicJwks,
          secretsFile: relativeSecrets,
          turnKeyId: resources.turnKeyId,
          tunnelId: resources.tunnelId,
        };
        writeOnce(configFile, `${JSON.stringify(config, null, 2)}\n`);
      } finally {
        privateKey.fill(0);
      }
    }
    const config = configSchema.parse(JSON.parse(privateFile(configFile).toString("utf8")));
    validateConfig(config);
    if (
      config.accountUrl !== `https://${resources.accountDomain}` ||
      config.signalUrl !== `wss://${resources.signalDomain}/v1/signal` ||
      config.signalPort !== resources.localSignalPort ||
      config.healthPort !== resources.localHealthPort ||
      config.ticketKeyId !== resources.ticketKeyId ||
      config.turnKeyId !== resources.turnKeyId ||
      config.tunnelId !== resources.tunnelId
    )
      fail();
    loadIndependentMobileSecrets(projectRoot);
    setDevelopmentOverrides(projectRoot, { OPENBOT_INDEPENDENT_MOBILE_CONFIG_FILE: relativeConfig });
    return config;
  } catch {
    return fail();
  }
}

function executable(name: "bun" | "cloudflared") {
  const override = process.env[name === "bun" ? "OPENBOT_BUN_EXECUTABLE" : "OPENBOT_CLOUDFLARED_EXECUTABLE"];
  const candidates = override
    ? [override]
    : [
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, name)),
        join("/opt/homebrew/bin", name),
        join("/usr/local/bin", name),
        ...(name === "bun" && process.env.HOME ? [join(process.env.HOME, ".bun/bin/bun")] : []),
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, fileConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* Try the next known executable path. */
    }
  }
  return fail();
}

function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function availablePort(port: number) {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", () => reject(new MobileLauncherError("A local mobile connection port is already in use.")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolvePort()));
  });
}

async function waitForSignal(child: ChildProcess, port: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) fail();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      /* The child can still be starting. Wait for its health state. */
    }
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  fail();
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    if (!child.kill("SIGTERM")) {
      clearTimeout(timeout);
      resolveStop();
    }
  });
}

function removeOwnedFile(path: string, inode: number) {
  try {
    if (existsSync(path) && lstatSync(path).ino === inode) unlinkSync(path);
  } catch {
    logger.warn("A private runtime file could not be removed.");
  }
}

function absentProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // A live reused PID, EPERM or another uncertain result never permits recovery.
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

function launcherRecord(path: string, projectRoot: string): LauncherLockRecord {
  try {
    const record = launcherLockSchema.parse(JSON.parse(privateFile(path).toString("utf8")));
    if (record.projectRoot !== projectRoot) fail();
    return record;
  } catch {
    throw new MobileLauncherError("The local mobile launcher lock is unreadable or belongs to another project.");
  }
}

function latestLauncherLock(directory: string): { generation: number; path: string } | null {
  let current: { generation: number; path: string } | null = null;
  for (const name of readdirSync(directory)) {
    const match = /^mobile-run\.(\d+)\.lock$/u.exec(name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) fail();
    if (!current || generation > current.generation) current = { generation, path: join(directory, name) };
  }
  if (current) return current;
  const legacy = join(directory, "mobile-run.lock");
  try {
    lstatSync(legacy);
    return { generation: 0, path: legacy };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function publishLauncherRecord(path: string, record: LauncherLockRecord, replace: boolean): boolean {
  const staging = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const descriptor = openSync(staging, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    if (replace) renameSync(staging, path);
    else linkSync(staging, path);
    return true;
  } catch (error) {
    if (!replace && isExisting(error)) return false;
    throw error;
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
}

/** Immutable generation paths prevent competing restarts from removing a newer owner's lock. */
export async function acquireIndependentMobileLock(
  projectRoot: string,
  ports: { signalPort: number; healthPort: number },
): Promise<{ recordChild(component: MobileComponent, pid: number): void; release(): void }> {
  const directory = privateDirectory(projectRoot);
  const record: LauncherLockRecord = {
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot,
    children: [],
    released: false,
  };
  let path: string;
  for (;;) {
    const current = latestLauncherLock(directory);
    if (current) {
      const holder = launcherRecord(current.path, projectRoot);
      if (
        !holder.released &&
        (!absentProcess(holder.launcherPid) || holder.children.some((child) => !absentProcess(child.pid)))
      )
        throw new MobileLauncherError("Another local mobile launcher or its child still owns the lock.");
    }
    await availablePort(ports.signalPort);
    await availablePort(ports.healthPort);
    const generation = (current?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) fail();
    path = join(directory, `mobile-run.${generation}.lock`);
    if (!publishLauncherRecord(path, record, false)) continue;
    if (current) logger.info("A previous mobile launcher record was retained.", { generation: current.generation });
    break;
  }
  const update = () => {
    const holder = launcherRecord(path, projectRoot);
    if (holder.launcherPid !== record.launcherPid || holder.startedAt !== record.startedAt || holder.released)
      throw new MobileLauncherError("The local mobile launcher lock changed while services were running.");
    publishLauncherRecord(path, record, true);
  };
  return {
    recordChild(component, pid) {
      record.children.push({ component, pid });
      update();
    },
    release() {
      record.released = true;
      update();
    },
  };
}

/** Reports process outcomes without copying child output, arguments or environment into a log. */
export function startIndependentMobileChild(
  component: MobileComponent,
  command: string,
  args: string[],
  options: { projectRoot: string; environment: NodeJS.ProcessEnv; requestedStop: () => boolean; stopped: () => void },
): ChildProcess {
  const child = spawn(command, args, { cwd: options.projectRoot, env: options.environment, stdio: "ignore" });
  child.once("error", () => {
    logger.error("A local mobile service could not start.", { component });
    options.stopped();
  });
  child.once("exit", (code, signal) => {
    const details = { component, pid: child.pid ?? null, code, signal, requestedStop: options.requestedStop() };
    if (details.requestedStop) logger.info("A local mobile service stopped.", details);
    else logger.warn("A local mobile service stopped unexpectedly.", details);
    options.stopped();
  });
  return child;
}

/** Starts two owned children in the foreground. It installs no service and changes no network configuration. */
export async function runIndependentMobile(projectRoot = projectDirectory): Promise<void> {
  const config = prepareIndependentMobile(projectRoot);
  const secrets = loadIndependentMobileSecrets(projectRoot);
  const directory = privateDirectory(projectRoot);
  const privateKey = privateFile(join(directory, "transfer-private.pem"));
  let turn: z.infer<typeof turnResourceSchema>;
  let tunnel: z.infer<typeof tunnelResourceSchema>;
  try {
    turn = decodeEnvelope(join(directory, "turn.sealed.json"), privateKey, turnResourceSchema);
    tunnel = decodeEnvelope(join(directory, "tunnel.sealed.json"), privateKey, tunnelResourceSchema);
  } catch {
    return fail();
  } finally {
    privateKey.fill(0);
  }
  registerSecretValues([turn.secret, tunnel.token]);
  if (turn.uid !== config.turnKeyId || tunnel.id !== config.tunnelId) fail();
  const bun = executable("bun");
  const cloudflared = executable("cloudflared");
  const lock = await acquireIndependentMobileLock(projectRoot, config);
  const children: ChildProcess[] = [];
  let runtimeDirectory: string | null = null;
  let tokenFile: string | null = null;
  let tokenInode: number | null = null;
  let tunnelConfigFile: string | null = null;
  let tunnelConfigInode: number | null = null;
  let requestedStop = false;
  let stoppingChildren = false;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolveFinished) => {
    finish = resolveFinished;
  });
  const requestStop = (signal: "SIGINT" | "SIGTERM") => {
    logger.info("The local mobile launcher received a stop signal.", { signal });
    requestedStop = true;
    finish();
  };
  const interrupt = () => requestStop("SIGINT");
  const terminate = () => requestStop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const startChild = (component: MobileComponent, command: string, args: string[], environment: NodeJS.ProcessEnv) => {
    const child = startIndependentMobileChild(component, command, args, {
      projectRoot,
      environment,
      requestedStop: () => requestedStop || stoppingChildren,
      stopped: finish,
    });
    children.push(child);
    if (child.pid) lock.recordChild(component, child.pid);
    return child;
  };
  try {
    if (requestedStop) return;
    runtimeDirectory = mkdtempSync(join(directory, "mobile-runtime-"));
    tokenFile = join(runtimeDirectory, "tunnel-token");
    writeFileSync(tokenFile, tunnel.token, { flag: "wx", mode: 0o600 });
    tokenInode = lstatSync(tokenFile).ino;
    // Do not load an unrelated ~/.cloudflared/config.yml. Ingress comes from this remote tunnel.
    tunnelConfigFile = join(runtimeDirectory, "cloudflared.json");
    writeFileSync(tunnelConfigFile, "{}\n", { flag: "wx", mode: 0o600 });
    tunnelConfigInode = lstatSync(tunnelConfigFile).ino;
    const signal = startChild("signal", bun, ["--no-env-file", join(projectRoot, "remote/api/src/index.ts")], {
      ...childEnvironment(),
      OPENBOT_SELF_HOSTED_API_URL: config.accountUrl,
      REMOTE_TLS_DISABLED: "true",
      REMOTE_SIGNAL_HOST: "127.0.0.1",
      REMOTE_SIGNAL_PORT: String(config.signalPort),
      REMOTE_HEALTH_HOST: "127.0.0.1",
      REMOTE_HEALTH_PORT: String(config.healthPort),
      REMOTE_TICKET_PUBLIC_JWKS: secrets.ticketPublicJwks,
      REMOTE_CONTROL_PLANE_URL: config.accountUrl,
      REMOTE_SESSION_SECRET: secrets.sessionSecret,
      REMOTE_AUTH_WEBHOOK_SECRET: secrets.authWebhookSecret,
      REMOTE_TRUST_PROXY: "false",
      TURN_PROVIDER: "cloudflare",
      TURN_CLOUDFLARE_KEY_ID: turn.uid,
      TURN_CLOUDFLARE_API_TOKEN: turn.secret,
    });
    await waitForSignal(signal, config.signalPort);
    if (requestedStop) return;
    startChild(
      "tunnel",
      cloudflared,
      ["tunnel", "--config", tunnelConfigFile, "--no-autoupdate", "run", "--token-file", tokenFile],
      childEnvironment(),
    );
    logger.info("Local mobile connection services started. Keep this process and the Mac running.");
    await finished;
    if (!requestedStop) throw new MobileLauncherError("A local mobile connection service stopped.");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    stoppingChildren = true;
    for (const child of children.reverse()) await stopChild(child);
    if (tokenFile && tokenInode !== null) removeOwnedFile(tokenFile, tokenInode);
    if (tunnelConfigFile && tunnelConfigInode !== null) removeOwnedFile(tunnelConfigFile, tunnelConfigInode);
    if (runtimeDirectory) {
      try {
        rmdirSync(runtimeDirectory);
      } catch {
        /* Keep unexpected files. */
      }
    }
    lock.release();
    logger.info("Local mobile connection services stopped.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    logger.info(
      "Use --prepare to create private configuration, or --start to run Signal and Cloudflare Tunnel in the foreground.",
    );
    if (args.length !== 1) process.exitCode = 1;
    return;
  }
  if (args[0] === "--prepare") {
    prepareIndependentMobile();
    logger.info("Private mobile connection configuration is ready.");
    return;
  }
  if (args[0] === "--start") {
    await runIndependentMobile();
    return;
  }
  throw new MobileLauncherError("Use --prepare, --start, or --help.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    logger.error(error instanceof MobileLauncherError ? error.message : "Local mobile connection setup failed.");
    process.exitCode = 1;
  });
}
