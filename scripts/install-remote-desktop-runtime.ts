import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { z } from "zod";
import { createRemoteDesktopInputDigest, loadNativeRuntimeLock, type NativeRuntimeLock } from "./native-runtime-lock";
import {
  listArchiveEntries,
  parseReleaseManifest,
  type RemoteDesktopReleaseManifest,
  type RemoteDesktopTarget,
  rejectNonRegularFiles,
  runtimeTarget,
  runtimeTargetParts,
  sha256,
} from "./remote-desktop-runtime-release";
import { download, installValidatedTree, isCurrentInstallation, type RuntimeFetch } from "./runtime-install";

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
});
type GitHubRelease = z.infer<typeof githubReleaseSchema>;
type GitHubReleaseAsset = GitHubRelease["assets"][number];

const logger = createOpenBotLogger("install-remote-desktop-runtime");

export async function installRemoteDesktopRuntime(
  input: {
    sourceRoot?: string;
    outputRoot?: string;
    target?: RemoteDesktopTarget;
    fetchImpl?: RuntimeFetch;
    githubToken?: string;
    /** A user-owned immutable mirror. The lock's manifest/archive hashes still apply. */
    artifactBaseUrl?: string;
    /** Explicitly permit the lock's public open-source runtime release, without GitHub credentials. */
    allowPinnedOpenSourceRelease?: boolean;
  } = {},
): Promise<"installed" | "current"> {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? resolve(sourceRoot, "build/remote-desktop-runtime");
  const target = input.target ?? runtimeTarget();
  const fetchImpl = input.fetchImpl ?? fetch;
  const lock = await loadNativeRuntimeLock(sourceRoot);
  const release = lock.remoteDesktop.artifactRelease;
  const artifact = lock.remoteDesktop.releaseArtifacts[target];

  if (await isCurrentInstallation(() => verifyRuntimeTree(outputRoot, target, lock))) {
    logger.info(`The ${target} remote desktop runtime is current.`);
    return "current";
  }
  if (!release || !artifact) throw new Error(`No published remote desktop runtime is pinned for ${target}.`);
  const allowPinnedOpenSourceRelease =
    input.allowPinnedOpenSourceRelease ?? process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME === "1";
  const source = remoteDesktopArtifactSource(lock, input.artifactBaseUrl, allowPinnedOpenSourceRelease);
  if (!source) {
    throw new Error(
      "Vendor runtime downloads are disabled. Build this checkout's remote desktop runtime from source, " +
        "pin your own release / configure OPENBOT_REMOTE_DESKTOP_ARTIFACT_BASE_URL, " +
        "or explicitly set OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME=1 for the locked public open-source components.",
    );
  }

  let manifestUrl: string;
  let archiveUrl: string;
  if (source.kind === "mirror") {
    manifestUrl = mirrorAssetUrl(source.baseUrl, release.manifestAsset);
    archiveUrl = mirrorAssetUrl(source.baseUrl, artifact.asset);
  } else {
    // The explicit public component source must not receive an unrelated shell or caller token.
    const githubToken = allowPinnedOpenSourceRelease ? undefined : (input.githubToken ?? process.env.GITHUB_TOKEN);
    const releaseResponse = await fetchImpl(
      `https://api.github.com/repos/${source.repository}/releases/tags/${encodeURIComponent(release.tag)}`,
      {
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "OpenBot-runtime-installer",
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
      },
    );
    if (!releaseResponse.ok) throw new Error(`Runtime release lookup failed with HTTP ${releaseResponse.status}.`);
    const githubRelease = githubReleaseSchema.parse(await releaseResponse.json());
    validateGitHubRelease(githubRelease, release.tag);
    manifestUrl = ownedGitHubAssetUrl(findAsset(githubRelease, release.manifestAsset), source.repository, release.tag);
    archiveUrl = ownedGitHubAssetUrl(findAsset(githubRelease, artifact.asset), source.repository, release.tag);
  }

  // Mirrors serve immutable bytes directly. GitHub's own release URLs can redirect to its asset CDN.
  const artifactFetch: RuntimeFetch =
    source.kind === "mirror" ? (request, init) => fetchImpl(request, { ...init, redirect: "error" }) : fetchImpl;
  const manifestBytes = await download(artifactFetch, manifestUrl, "Runtime asset");
  if (sha256(manifestBytes) !== release.manifestSha256)
    throw new Error("The runtime release manifest checksum is invalid.");
  const manifest = parseReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  validateManifest(lock, manifest, target);

  const archiveBytes = await download(artifactFetch, archiveUrl, "Runtime asset");
  if (sha256(archiveBytes) !== artifact.sha256) throw new Error(`The ${target} runtime archive checksum is invalid.`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-runtime-install-"));
  try {
    const archive = join(temporaryRoot, artifact.asset);
    const extracted = join(temporaryRoot, "extracted");
    await writeFile(archive, archiveBytes);
    listArchiveEntries(archive);
    await mkdir(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"], { stdio: "inherit" });
    const extractedRuntime = join(extracted, "remote-desktop-runtime");
    await rejectNonRegularFiles(extractedRuntime);
    await verifyRuntimeTree(extractedRuntime, target, lock);
    await installRuntimeTree(extractedRuntime, outputRoot, target);
    await verifyRuntimeTree(outputRoot, target, lock);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  logger.info(`Installed the pinned ${target} remote desktop runtime.`);
  return "installed";
}

export type RemoteDesktopArtifactSource = { kind: "mirror"; baseUrl: string } | { kind: "github"; repository: string };

/** The public source remains opt-in. Its exact release and every digest still come from the lock. */
export function remoteDesktopArtifactSource(
  lock: NativeRuntimeLock,
  mirror = process.env.OPENBOT_REMOTE_DESKTOP_ARTIFACT_BASE_URL,
  allowPinnedOpenSourceRelease = process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME === "1",
): RemoteDesktopArtifactSource | null {
  if (mirror?.trim()) {
    const url = new URL(mirror);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const path = url.pathname.toLowerCase();
    if (
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname === "openbot.run" ||
      url.hostname.endsWith(".openbot.run") ||
      url.hostname === "openbot.site" ||
      url.hostname.endsWith(".openbot.site") ||
      ((url.hostname === "github.com" || url.hostname === "raw.githubusercontent.com") &&
        path.startsWith("/nightly-labs/openbot")) ||
      (url.hostname === "api.github.com" && path.startsWith("/repos/nightly-labs/openbot"))
    )
      throw new Error("The runtime mirror must be a user-owned HTTPS or loopback base URL without credentials.");
    return { kind: "mirror", baseUrl: url.toString().replace(/\/+$/u, "") };
  }
  const repository = lock.remoteDesktop.artifactRelease?.repository;
  if (
    !repository ||
    (repository.toLowerCase() === "nightly-labs/openbot" && !allowPinnedOpenSourceRelease) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return { kind: "github", repository };
}

function mirrorAssetUrl(baseUrl: string, asset: string): string {
  return new URL(encodeURIComponent(asset), `${baseUrl}/`).toString();
}

function ownedGitHubAssetUrl(asset: GitHubReleaseAsset, repository: string, tag: string): string {
  const url = new URL(asset.browser_download_url);
  const expected = `/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error("The runtime asset is outside the pinned user-owned GitHub release.");
  }
  return url.toString();
}

export function validateGitHubRelease(release: GitHubRelease, expectedTag: string): void {
  if (release.tag_name !== expectedTag || release.draft || !release.prerelease) {
    throw new Error("The pinned runtime release is not a published prerelease with the expected tag.");
  }
}

export function validateManifest(
  lock: NativeRuntimeLock,
  manifest: RemoteDesktopReleaseManifest,
  target: RemoteDesktopTarget,
): void {
  const release = lock.remoteDesktop.artifactRelease;
  const artifact = lock.remoteDesktop.releaseArtifacts[target];
  if (!release || !artifact) throw new Error(`No published remote desktop runtime is pinned for ${target}.`);
  const digest = createRemoteDesktopInputDigest(lock);
  if (
    manifest.inputDigest !== digest ||
    manifest.inputDigest !== release.inputDigest ||
    manifest.repository !== release.repository ||
    manifest.tag !== release.tag ||
    manifest.recipeVersion !== lock.remoteDesktop.recipeVersion ||
    manifest.sources.sunshine.commit !== lock.remoteDesktop.sunshine.commit ||
    manifest.sources.sunshine.licenseSha256 !== lock.remoteDesktop.sunshine.licenseSha256 ||
    manifest.sources.moonlightWeb.commit !== lock.remoteDesktop.moonlightWeb.commit ||
    manifest.sources.moonlightWeb.licenseSha256 !== lock.remoteDesktop.moonlightWeb.licenseSha256 ||
    manifest.artifacts[target].asset !== artifact.asset ||
    manifest.artifacts[target].sha256 !== artifact.sha256
  ) {
    throw new Error("The runtime release manifest does not match the lock file.");
  }
}

export async function verifyRuntimeTree(
  root: string,
  target: RemoteDesktopTarget,
  lock: NativeRuntimeLock,
): Promise<void> {
  const { platform, architecture } = runtimeTargetParts(target);
  const sourceManifest = JSON.parse(await readFile(join(root, "source-manifest.json"), "utf8"));
  if (
    sourceManifest.inputDigest !== createRemoteDesktopInputDigest(lock) ||
    sourceManifest.sunshine?.commit !== lock.remoteDesktop.sunshine.commit ||
    sourceManifest.moonlightWeb?.commit !== lock.remoteDesktop.moonlightWeb.commit
  ) {
    throw new Error("The installed runtime source manifest does not match the lock file.");
  }
  await verifyChecksumFile(root, "DISTRIBUTION-SHA256SUMS.txt");
  await verifyChecksumFile(join(root, platform, architecture), "SHA256SUMS.txt");
  const required = [
    ...lock.remoteDesktop.targets[target],
    "static/stream.html",
    "static/stream/index.js",
    "SHA256SUMS.txt",
  ];
  for (const name of required) await readFile(join(root, platform, architecture, ...name.split("/")));
}

function findAsset(release: GitHubRelease, name: string): GitHubReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`The runtime release does not contain ${name}.`);
  return asset;
}

async function verifyChecksumFile(root: string, fileName: string): Promise<void> {
  const contents = await readFile(join(root, fileName), "utf8");
  for (const line of contents.trim().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid runtime checksum line: ${line}`);
    const name = match[2];
    if (!name) throw new Error("A runtime checksum has no file name.");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      /^[A-Za-z]:/u.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe checksum path: ${name}`);
    }
    const path = join(root, ...name.split("/"));
    if (sha256(await readFile(path)) !== match[1]) throw new Error(`Invalid runtime checksum for ${name}.`);
  }
}

async function installRuntimeTree(source: string, destination: string, target: RemoteDesktopTarget): Promise<void> {
  const { platform, architecture } = runtimeTargetParts(target);
  await installValidatedTree(join(source, platform, architecture), join(destination, platform, architecture));
  for (const name of ["licenses", "sources"]) {
    const destinationPath = join(destination, name);
    await rm(destinationPath, { recursive: true, force: true });
    await cp(join(source, name), destinationPath, { recursive: true });
  }
  await mkdir(destination, { recursive: true });
  await Promise.all(
    ["source-manifest.json", "DISTRIBUTION-SHA256SUMS.txt"].map((name) =>
      cp(join(source, name), join(destination, name)),
    ),
  );
}

if (import.meta.main) {
  const platform = process.argv[2] ?? process.platform;
  const architecture = process.argv[3] ?? process.arch;
  await installRemoteDesktopRuntime({ target: runtimeTarget(platform, architecture) });
}
