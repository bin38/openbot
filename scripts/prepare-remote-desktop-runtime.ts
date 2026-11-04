import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { remoteDesktopArtifactSource, verifyRuntimeTree } from "./install-remote-desktop-runtime";
import { hasPinnedRemoteDesktopArtifacts, loadNativeRuntimeLock } from "./native-runtime-lock";
import { runtimeTarget } from "./remote-desktop-runtime-release";
import { isCurrentInstallation } from "./runtime-install";

const lock = await loadNativeRuntimeLock();
const platform = process.argv[2] ?? process.platform;
const architecture = process.argv[3] ?? process.arch;
const target = runtimeTarget(platform, architecture);
if (await isCurrentInstallation(() => verifyRuntimeTree(resolve("build/remote-desktop-runtime"), target, lock))) {
  createOpenBotLogger("prepare-remote-desktop-runtime").info("The verified local remote desktop runtime is current.");
} else if (hasPinnedRemoteDesktopArtifacts(lock) && remoteDesktopArtifactSource(lock)) {
  execFileSync("bun", ["scripts/install-remote-desktop-runtime.ts", platform, architecture], { stdio: "inherit" });
} else if (process.env.OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD === "1") {
  if (target !== runtimeTarget())
    throw new Error("Build this target on its own platform or configure a verified artifact mirror.");
  execFileSync("bun", ["scripts/build-remote-desktop-runtime.ts"], { stdio: "inherit" });
  await verifyRuntimeTree(resolve("build/remote-desktop-runtime"), target, lock);
} else {
  throw new Error(
    "No verified local runtime or user-owned artifact source is available. " +
      "Set OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD=1 to use this checkout's source recipe, " +
      "pin your own release / configure OPENBOT_REMOTE_DESKTOP_ARTIFACT_BASE_URL, " +
      "or explicitly set OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME=1 for the locked public open-source components. " +
      "Vendor downloads are disabled by default.",
  );
}
