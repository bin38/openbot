import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpenBotLogger } from "@openbot/logging";
import { parse } from "yaml";
import { z } from "zod";
import { parseIndependentServices } from "../src/main/independent-installation";
import { readScriptArguments } from "./script-arguments";

export const INDEPENDENT_MACOS_IDENTITY = {
  productName: "OpenBot 独立版",
  executableName: "OpenBot 独立版",
  bundleId: "im.ily.openbot.desktop",
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logger = createOpenBotLogger("package-independent-macos");
const jsonObject = z.record(z.string(), z.json());
type BuilderObject = z.infer<typeof jsonObject>;
type BuilderValue = z.infer<ReturnType<typeof z.json>>;

interface IndependentPackagePaths {
  config: string;
  services: string;
  app: string;
  output: string;
}

const PUBLIC_SOURCES = new Set([
  "resources/managed-skills",
  "resources/plugin-catalog",
  "resources/agent-import",
  "resources/cli",
  "resources/agent-runtime",
  "build/icon-production.png",
  "build/icon-dev.png",
  "build/icon-preview.png",
  "build/logo-colors",
  "node_modules/electron/dist/LICENSE",
  "node_modules/electron/dist/LICENSES.chromium.html",
  "build/licenses/sherpa-onnx-LICENSE",
  "build/licenses/onnxruntime-LICENSE",
  "build/licenses/NVIDIA-Parakeet-TDT-0.6B-v3-LICENSE",
  "build/licenses/Underdog-Bark-3.0-Plus-LICENSE",
  "build/licenses/OpenAI-Whisper-LICENSE",
  "build/licenses/Supertone-Supertonic-3-LICENSE",
  "build/macos/Assets.car",
  "build/icon-production-macos-safe-area.png",
  "build/icon-dev-macos-safe-area.png",
  "build/icon-preview-macos-safe-area.png",
  "build/macos/tray",
  ".openbot-build/voice/runtime",
  "build/remote-desktop-runtime",
  "build/cua-driver/darwin/${arch}",
]);
const PACKAGE_FILES = new Set(["out/**/*", "package.json", "LICENSE", "NOTICE"]);

function object(value: BuilderValue | undefined, name: string): BuilderObject {
  const decoded = jsonObject.safeParse(value);
  if (!decoded.success) throw new Error(`The base package configuration has no valid ${name}.`);
  return decoded.data;
}

/** Only reviewed public inputs enter the bundle. Operator state and credentials stay outside it. */
function resources(value: BuilderValue | undefined): BuilderObject[] {
  if (!Array.isArray(value)) throw new Error("The base package resources must be explicit file sets.");
  return value.map((entry) => {
    const resource = object(entry, "resource");
    if (typeof resource.from !== "string" || !PUBLIC_SOURCES.has(resource.from)) {
      throw new Error("The base package contains an unreviewed resource source.");
    }
    if (typeof resource.to !== "string" || resource.to.startsWith("/") || resource.to.split("/").includes("..")) {
      throw new Error("The base package contains an invalid resource destination.");
    }
    if (resource.from === ".openbot-build/voice/runtime") {
      resource.filter = ["sherpa-onnx.node", "libsherpa-onnx-c-api.dylib", "libonnxruntime.dylib"];
    } else if (resource.from === "build/remote-desktop-runtime") {
      resource.filter = [
        "darwin/arm64/**/*",
        "licenses/**/*",
        "sources/**/*",
        "source-manifest.json",
        "DISTRIBUTION-SHA256SUMS.txt",
      ];
    } else if (resource.from === "build/cua-driver/darwin/${arch}") {
      resource.filter = ["cua-driver", "LICENSE.md"];
    }
    return resource;
  });
}

/** Makes a complete config without inheriting the original publisher's signing or update identity. */
export async function prepareIndependentMacosPackage(
  input: { accountUrl: string; signalUrl: string },
  projectRoot = ROOT,
): Promise<IndependentPackagePaths> {
  const services = parseIndependentServices(JSON.stringify({ version: 1, ...input }));
  const base = jsonObject.parse(parse(await readFile(join(projectRoot, "electron-builder.yml"), "utf8")));
  const mac = object(base.mac, "mac settings");
  const files = z.array(z.string()).parse(base.files);
  if (files.some((file) => !file.startsWith("!") && !PACKAGE_FILES.has(file))) {
    throw new Error("The base package file list may copy private operator files.");
  }
  if (base.asar !== true || [...PACKAGE_FILES].some((file) => !files.includes(file))) {
    throw new Error("The independent package must retain ASAR, the application output and its license notices.");
  }
  if (base.afterPack !== undefined || base.afterSign !== undefined || mac.sign !== undefined) {
    throw new Error("Review package hooks before using them in an independent local build.");
  }
  const commonResources = resources(base.extraResources);
  const macResources = resources(mac.extraResources);
  const extendInfo = object(mac.extendInfo, "mac Info.plist settings");
  delete extendInfo.ElectronTeamID;
  delete extendInfo.CFBundleIdentifier;
  delete extendInfo.CFBundleDisplayName;
  delete extendInfo.CFBundleName;
  delete extendInfo.CFBundleExecutable;
  delete mac.provisioningProfile;
  delete base.executableName;
  delete mac.executableName;

  const configRoot = join(projectRoot, ".openbot-build", "independent-macos");
  const output = join(projectRoot, "dist", "independent-macos");
  const servicesPath = join(configRoot, "independent-services.json");
  const configPath = join(configRoot, "electron-builder.json");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await writeFile(servicesPath, `${JSON.stringify(services, null, 2)}\n`, { mode: 0o644 });
  // This public resource is copied into a system-wide application; it contains no credential.
  await chmod(servicesPath, 0o644);

  const configuration: BuilderObject = {
    ...base,
    appId: INDEPENDENT_MACOS_IDENTITY.bundleId,
    productName: INDEPENDENT_MACOS_IDENTITY.productName,
    artifactName: "OpenBot-Independent-${version}-${arch}.${ext}",
    publish: null,
    forceCodeSigning: false,
    files: [
      ...files,
      "!out/**/.openbot{,/**}",
      "!out/**/.env*",
      "!out/**/*.{db,sqlite,sqlite3,key,pem,p12}",
      "!out/**/*.{db-wal,db-shm}",
    ],
    directories: { ...object(base.directories, "directories"), output },
    extraResources: [...commonResources, { from: servicesPath, to: "independent-services.json" }],
    mac: {
      ...mac,
      identity: null,
      notarize: false,
      entitlements: join(projectRoot, "build", "entitlements.independent.mac.plist"),
      extendInfo,
      extraResources: macResources,
      target: ["dmg", "zip"],
    },
  };
  await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return {
    config: configPath,
    services: servicesPath,
    app: join(output, "mac-arm64", `${INDEPENDENT_MACOS_IDENTITY.productName}.app`),
    output,
  };
}

function buildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("CSC_") ||
      name.startsWith("APPLE_") ||
      ["MAC_PROVISIONING_PROFILE", "GITHUB_TOKEN", "GH_TOKEN"].includes(name)
    )
      delete environment[name];
  }
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return environment;
}

async function run(command: string, args: string[], label: string): Promise<void> {
  logger.info(label);
  await new Promise<void>((complete, fail) => {
    const child = spawn(command, args, { cwd: ROOT, env: buildEnvironment(), stdio: "inherit" });
    child.once("error", () => fail(new Error(`${label} could not start.`)));
    child.once("exit", (code, signal) => {
      if (code === 0) complete();
      else fail(new Error(`${label} failed (${signal ?? `exit ${code ?? 1}`}).`));
    });
  });
}

async function main(): Promise<void> {
  const args = readScriptArguments({
    usage:
      "Usage: bun scripts/package-independent-macos.ts --account-url=https://account.example.com --signal-url=wss://signal.example.com/v1/signal [--prepare-only]",
    options: {
      "account-url": { type: "string" },
      "signal-url": { type: "string" },
      "prepare-only": { type: "boolean" },
    },
  });
  if (!args) return;
  const accountUrl = args.values["account-url"];
  const signalUrl = args.values["signal-url"];
  if (!accountUrl || !signalUrl) throw new Error("Set both own-service URLs explicitly.");
  if (!args.values["prepare-only"] && (process.platform !== "darwin" || process.arch !== "arm64")) {
    throw new Error("Build this independent macOS package on an Apple silicon Mac.");
  }
  const paths = await prepareIndependentMacosPackage({ accountUrl, signalUrl });
  logger.info("Prepared independent macOS packaging configuration.", { config: paths.config, output: paths.output });
  if (args.values["prepare-only"]) return;
  for (const step of [
    "voice:prepare-runtime",
    "prepare:remote-desktop-runtime",
    "verify:remote-desktop-runtime",
    "prepare:cua-driver",
    "build",
    "verify:preload",
  ]) {
    await run(process.execPath, ["--no-env-file", "run", step], step);
  }
  await run(
    join(ROOT, "node_modules", ".bin", "electron-builder"),
    [
      "--config",
      paths.config,
      "--mac",
      "dmg",
      "zip",
      "--arm64",
      "--publish",
      "never",
      "--config.mac.identity=null",
      "--config.mac.notarize=false",
    ],
    "Build the independent DMG and ZIP",
  );
  await run(
    process.execPath,
    ["--no-env-file", "scripts/verify-macos-package.ts", paths.app, "--independent"],
    "Verify the independent package",
  );
  logger.info("Independent macOS artifacts are ready. They are not Apple-notarized.", { output: paths.output });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    logger.error(error instanceof Error ? error.message : "Independent macOS packaging failed.");
    process.exitCode = 1;
  });
}
