// Exercises source selection and real filesystem validation, not native compilation.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import {
  installRemoteDesktopRuntime,
  remoteDesktopArtifactSource,
  verifyRuntimeTree,
} from "./install-remote-desktop-runtime";
import {
  createRemoteDesktopInputDigest,
  createRemoteDesktopReleaseTag,
  createRemoteDesktopSourceManifest,
  loadNativeRuntimeLock,
} from "./native-runtime-lock";
import {
  createReleaseManifest,
  type RemoteDesktopTarget,
  remoteDesktopTargets,
  sha256,
} from "./remote-desktop-runtime-release";
import type { RuntimeFetch } from "./runtime-install";

const logger = createOpenBotLogger("independent-runtime-source-e2e");
const output = resolve(".openbot-build/independent-runtime-source-e2e");
const temporary = await mkdtemp(join(tmpdir(), "independent-runtime-source-"));
const checks: string[] = [];
let networkCalls = 0;
let mirrorCalls = 0;
let mirrorReceivedCredential = false;
let publicReleaseCalls = 0;
let publicReleaseReceivedCredential = false;
let publicManifest = Buffer.from("untrusted public manifest");
let publicRelease: {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
} | null = null;
let passed = false;
const previousPublicSource = process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME;
delete process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME;
const deniedFetch: RuntimeFetch = async () => {
  networkCalls += 1;
  throw new Error("A vendor request was attempted.");
};
const server = createServer((request, response) => {
  if (request.url?.startsWith("/pinned-")) {
    publicReleaseCalls += 1;
    publicReleaseReceivedCredential ||= request.headers.authorization !== undefined;
    if (request.url === "/pinned-release")
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(publicRelease));
    else if (request.url === "/pinned-manifest")
      response.writeHead(200, { "content-type": "application/json" }).end(publicManifest);
    else response.writeHead(200).end("untrusted public archive");
    return;
  }
  mirrorReceivedCredential = request.headers.authorization !== undefined;
  mirrorCalls += 1;
  response.writeHead(200, { "content-type": "application/json" }).end("untrusted artifact bytes");
});

try {
  const source = join(temporary, "source");
  await mkdir(source, { recursive: true });
  const lock = await loadNativeRuntimeLock();
  const digest = createRemoteDesktopInputDigest(lock);
  lock.remoteDesktop.artifactRelease = {
    repository: "nightly-labs/openbot",
    tag: createRemoteDesktopReleaseTag(digest),
    inputDigest: digest,
    manifestAsset: "remote-desktop-runtime-manifest.json",
    manifestSha256: "0".repeat(64),
  };
  for (const target of remoteDesktopTargets)
    lock.remoteDesktop.releaseArtifacts[target] = { asset: `runtime-${target}.tar.gz`, sha256: "0".repeat(64) };
  await writeFile(join(source, "native-runtime.lock.json"), JSON.stringify(lock));
  for (const runtime of [lock.remoteDesktop.sunshine, lock.remoteDesktop.moonlightWeb]) {
    for (const name of [runtime.patch.path, ...runtime.overrides.map((entry) => entry.source)]) {
      const destination = join(source, name);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(name), destination);
    }
  }
  const target = "darwin-arm64";
  const runtimeRoot = join(temporary, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const sentinel = join(runtimeRoot, "existing-user-file");
  await writeFile(sentinel, "keep this file");
  await assert.rejects(
    installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      fetchImpl: deniedFetch,
      artifactBaseUrl: "",
    }),
    /Vendor runtime downloads are disabled/,
  );
  assert.equal(networkCalls, 0);
  assert.equal(await readFile(sentinel, "utf8"), "keep this file");
  checks.push("missing local artifacts never trigger a vendor release lookup or remove existing files");

  const platformRoot = join(runtimeRoot, "darwin", "arm64");
  const files = [...lock.remoteDesktop.targets[target], "static/stream.html", "static/stream/index.js"];
  const sums: string[] = [];
  for (const name of files) {
    const file = join(platformRoot, ...name.split("/"));
    await mkdir(dirname(file), { recursive: true });
    const bytes = Buffer.from(`fixture file: ${name}`);
    await writeFile(file, bytes);
    sums.push(`${sha256(bytes)}  ${name}`);
  }
  await writeFile(join(platformRoot, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  const manifest = Buffer.from(JSON.stringify(createRemoteDesktopSourceManifest(lock)));
  await writeFile(join(runtimeRoot, "source-manifest.json"), manifest);
  await writeFile(join(runtimeRoot, "DISTRIBUTION-SHA256SUMS.txt"), `${sha256(manifest)}  source-manifest.json\n`);
  await verifyRuntimeTree(runtimeRoot, target, lock);
  assert.equal(
    await installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      fetchImpl: deniedFetch,
      artifactBaseUrl: "",
    }),
    "current",
  );
  assert.equal(networkCalls, 0);
  checks.push("a locally validated runtime is reused without a source lookup");

  const first = files[0];
  assert.ok(first);
  await writeFile(join(platformRoot, ...first.split("/")), "modified binary");
  await assert.rejects(verifyRuntimeTree(runtimeRoot, target, lock));
  await assert.rejects(
    installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      fetchImpl: deniedFetch,
      artifactBaseUrl: "",
    }),
    /Vendor runtime downloads are disabled/,
  );
  assert.equal(networkCalls, 0);
  checks.push("damaged local bytes fail verification and do not cause an upstream fallback");

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const mirror = `http://127.0.0.1:${address.port}/artifacts`;
  assert.deepEqual(remoteDesktopArtifactSource(lock, mirror), { kind: "mirror", baseUrl: mirror });
  await assert.rejects(
    installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      artifactBaseUrl: mirror,
      githubToken: "fixture-token-not-for-the-mirror",
    }),
    /manifest checksum is invalid/,
  );
  assert.equal(mirrorCalls, 1);
  assert.equal(mirrorReceivedCredential, false, "A mirror must not receive a GitHub token.");
  assert.equal(await readFile(sentinel, "utf8"), "keep this file");
  assert.throws(() =>
    remoteDesktopArtifactSource(lock, "https://github.com/nightly-labs/openbot/releases/download/tag"),
  );
  assert.throws(() => remoteDesktopArtifactSource(lock, "https://secret@artifacts.example/"));
  checks.push("an explicit owned mirror receives no GitHub credential and cannot replace files with unpinned bytes");

  assert.equal(remoteDesktopArtifactSource(lock, ""), null);
  assert.deepEqual(remoteDesktopArtifactSource(lock, "", true), { kind: "github", repository: "nightly-labs/openbot" });
  process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME = "1";
  assert.deepEqual(remoteDesktopArtifactSource(lock, ""), { kind: "github", repository: "nightly-labs/openbot" });
  assert.equal(
    remoteDesktopArtifactSource(lock, "", false),
    null,
    "The explicit input can keep public downloads disabled.",
  );
  delete process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME;
  const release = lock.remoteDesktop.artifactRelease;
  const archive = lock.remoteDesktop.releaseArtifacts[target];
  assert.ok(release && archive);
  const releaseLookup = `https://api.github.com/repos/${release.repository}/releases/tags/${encodeURIComponent(release.tag)}`;
  const assetUrl = (name: string) =>
    `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`;
  publicRelease = {
    tag_name: release.tag,
    draft: false,
    prerelease: true,
    assets: [release.manifestAsset, archive.asset].map((name) => ({ name, browser_download_url: assetUrl(name) })),
  };
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  const pinnedFetch: RuntimeFetch = async (request, init) => {
    const url = request instanceof Request ? request.url : request.toString();
    const path =
      url === releaseLookup
        ? "/pinned-release"
        : url === assetUrl(release.manifestAsset)
          ? "/pinned-manifest"
          : url === assetUrl(archive.asset)
            ? "/pinned-archive"
            : null;
    assert.ok(path, "The public source can request only the pinned release and its exact asset names.");
    return fetch(`${fixtureOrigin}${path}`, init);
  };
  await assert.rejects(
    installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      artifactBaseUrl: "",
      allowPinnedOpenSourceRelease: true,
      githubToken: "fixture-token-must-not-go-to-public-source",
      fetchImpl: pinnedFetch,
    }),
    /manifest checksum is invalid/,
  );
  assert.equal(publicReleaseCalls, 2);
  assert.equal(publicReleaseReceivedCredential, false);
  assert.equal(await readFile(sentinel, "utf8"), "keep this file");
  assert.equal(await readFile(join(platformRoot, ...first.split("/")), "utf8"), "modified binary");
  checks.push(
    "public open-source opt-in uses only the lock's GitHub release, sends no GitHub credential, and refuses an unpinned manifest before replacing files",
  );

  const manifestArtifact = (target: RemoteDesktopTarget) => {
    const entry = lock.remoteDesktop.releaseArtifacts[target];
    assert.ok(entry);
    return { ...entry, sbomAsset: `runtime-${target}.spdx.json`, sbomSha256: "0".repeat(64) };
  };
  publicManifest = Buffer.from(
    JSON.stringify(
      createReleaseManifest({
        lock,
        inputDigest: digest,
        repository: release.repository,
        tag: release.tag,
        artifacts: {
          "darwin-arm64": manifestArtifact("darwin-arm64"),
          "darwin-x64": manifestArtifact("darwin-x64"),
          "win32-x64": manifestArtifact("win32-x64"),
          "linux-x64": manifestArtifact("linux-x64"),
        },
      }),
    ),
  );
  release.manifestSha256 = sha256(publicManifest);
  await writeFile(join(source, "native-runtime.lock.json"), JSON.stringify(lock));
  await assert.rejects(
    installRemoteDesktopRuntime({
      sourceRoot: source,
      outputRoot: runtimeRoot,
      target,
      artifactBaseUrl: "",
      allowPinnedOpenSourceRelease: true,
      githubToken: "fixture-token-must-not-go-to-public-source",
      fetchImpl: pinnedFetch,
    }),
    /runtime archive checksum is invalid/,
  );
  assert.equal(publicReleaseCalls, 5);
  assert.equal(publicReleaseReceivedCredential, false);
  assert.equal(await readFile(sentinel, "utf8"), "keep this file");
  assert.equal(await readFile(join(platformRoot, ...first.split("/")), "utf8"), "modified binary");
  checks.push(
    "even an approved public manifest cannot install archive bytes that fail the pinned hash; existing files remain intact",
  );

  const ownLock = structuredClone(lock);
  assert.ok(ownLock.remoteDesktop.artifactRelease);
  ownLock.remoteDesktop.artifactRelease.repository = "fixture-owner/runtime";
  assert.deepEqual(remoteDesktopArtifactSource(ownLock, ""), { kind: "github", repository: "fixture-owner/runtime" });
  checks.push("a separately pinned own GitHub release is an explicit artifact source");
  passed = true;
} finally {
  if (previousPublicSource === undefined) delete process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME;
  else process.env.OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME = previousPublicSource;
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  await rm(temporary, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, publicReleaseCalls, publicReleaseReceivedCredential, nativeBuildRun: false, externalNetworkUsed: false }, null, 2)}\n`,
  );
}
logger.info("Independent runtime source checks passed.");
