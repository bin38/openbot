import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isKnownAttachmentName,
  isOpenableAttachmentName,
  isSupportedAttachmentNameFor,
} from "@openbot/contracts/attachment-files";
import type { AttachmentDataInput, TeamMemberSummary } from "@openbot/contracts/ipc";
import {
  ATTACHMENT_CHUNK_BYTES,
  decodeAttachmentUploadState,
  STREAMING_ATTACHMENT_CODECS,
  STREAMING_ATTACHMENT_ROUTES,
  STREAMING_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { TEAM_CAPABILITIES_HEADER, TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol/v1";
import { decodeTeamProtocolV2FileControlFrame } from "@openbot/contracts/team-protocol/v2";
import { uploadAttachmentStream } from "@openbot/team-client/attachment-streaming";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { Deferred, Effect, Result } from "effect";
import { AgentLifecycleFailed } from "../src/backend/agent-service";
import { AttachmentFiles, type StoredDraft, toAttachmentSummary } from "../src/backend/attachment-files";
import { AttachmentUploadSessions } from "../src/backend/attachment-upload-sessions";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { sha256File } from "../src/backend/file-hash";
import { AttachmentDownloadStopped } from "../src/main/remote-attachment-cache";
import { downloadRemoteAttachmentToDisk, uploadRemoteAttachmentPath } from "../src/main/remote-attachment-streaming";
import type { RemoteRequestFn } from "../src/main/remote-server-client";
import { RemoteWorkflowError, remoteCall } from "../src/main/remote-service-effects";
import { HttpError } from "../src/main/team-api/http-error";
import { routeAttachmentUploads } from "../src/main/team-api/route-attachment-uploads";

const artifact = join(dirname(dirname(import.meta.filename)), ".openbot-build/attachment-streaming-e2e/report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-streaming-e2e-"));
const files = new AttachmentFiles({ userDataPath: join(root, "data"), sharedRoot: join(root, "shared") });
const directory = join(root, "uploads");
const uploads = new AttachmentUploadSessions(directory);
const drafts = new Map<string, StoredDraft>();
const results: { check: string; bytes?: number }[] = [];
let heldRangeStarted: (() => void) | undefined;
let heldRangeClosed: (() => void) | undefined;

const prepare = (paths: string[], data: AttachmentDataInput[]) =>
  files.prepareDrafts(paths, data).pipe(
    Effect.map((created) => {
      for (const draft of created) drafts.set(draft.id, draft);
      return created.map(toAttachmentSummary);
    }),
    Effect.mapError(
      (failure) => new AgentLifecycleFailed({ operation: "prepareImportedAttachments", cause: failure.cause }),
    ),
  );
const server = createServer((request, response) => {
  void (async () => {
    const token = request.headers.authorization?.replace(/^Bearer /u, "");
    if (token !== "owner" && token !== "other") {
      response.writeHead(401).end();
      return;
    }
    const member: TeamMemberSummary = {
      id: token,
      username: token,
      name: token,
      email: null,
      role: "owner",
      createdAt: new Date().toISOString(),
      disabled: false,
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    // A real range request stays open until its client aborts; no elapsed-time barrier is used.
    if (url.searchParams.has("waitForCancel")) {
      await new Promise<void>((resolve) => {
        response.once("close", () => {
          heldRangeClosed?.();
          resolve();
        });
        heldRangeStarted?.();
      });
      return;
    }
    const codec = STREAMING_ATTACHMENT_CODECS.get(url.pathname);
    const outcome = await routeAttachmentUploads(
      {
        request,
        response,
        method: request.method ?? "GET",
        url,
        protocol: 9,
        capabilities: new Set(
          request.headers[TEAM_CAPABILITIES_HEADER.toLowerCase()] === STREAMING_ATTACHMENTS_CAPABILITY
            ? [STREAMING_ATTACHMENTS_CAPABILITY]
            : [],
        ),
        member,
        token,
        sessionId: token,
        sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        agentLevel: () => "manage",
        json: (status, value) => {
          response
            .writeHead(status, { "Content-Type": "application/json" })
            .end(JSON.stringify(codec?.response(status, value) ?? value));
          return "handled";
        },
        empty: (status) => {
          response.writeHead(status).end();
          return "handled";
        },
      },
      {
        uploads,
        agents: { prepareImportedAttachments: prepare },
        mailbox: { resolveAttachment: (id) => Effect.succeed(drafts.get(id) ?? null) },
      },
    );
    if (outcome === "unmatched") response.writeHead(404).end();
  })().catch((error: unknown) =>
    response
      .writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed" })),
  );
});

try {
  await runCauseEffect(files.initialize());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const requestFor =
    (token: string, capability = true, signal?: AbortSignal): TeamApiRequest =>
    async (method, path, decode, body) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: "9",
          [TEAM_CAPABILITIES_HEADER]: capability ? STREAMING_ATTACHMENTS_CAPABILITY : "",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      const value = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
      return decode(value);
    };
  const request = requestFor("owner");
  const remote: RemoteRequestFn = (_server, path, decode, init) =>
    remoteCall(() =>
      request(
        init?.method ?? "GET",
        path,
        decode,
        init?.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)),
      ),
    );
  const large = join(root, "large.zip");
  const second = join(root, "second.7z");
  for (const [path, size] of [
    [large, 128 * 1024 * 1024 + 17],
    [second, 130 * 1024 * 1024],
  ] as const) {
    const file = await open(path, "wx");
    await file.truncate(size);
    await file.write(Buffer.from("archive bytes stay unchanged"), 0, 28, 0);
    await file.close();
  }
  const local = await runCauseEffect(files.prepareDrafts([large, second], []));
  assert.ok(local.reduce((sum, file) => sum + file.size, 0) > 250 * 1024 * 1024);
  const committed = await runCauseEffect(
    files.commitMessageTransfer(
      "large-transfer",
      { kind: "user" },
      ["agent"],
      "message",
      new Date().toISOString(),
      local.map((item) => item.path),
    ),
  );
  assert.equal(committed[0]?.sha256, await runCauseEffect(sha256File(large)));
  assert.equal(committed[1]?.previewKind, "none");
  results.push({
    check: "local upload and message transfer exceed old single and total limits",
    bytes: local.reduce((sum, item) => sum + item.size, 0),
  });

  const uploaded = await runCauseEffect(uploadRemoteAttachmentPath(remote, "host", large));
  const downloaded = await runCauseEffect(
    downloadRemoteAttachmentToDisk(remote, "host", uploaded.id, join(root, "downloads")),
  );
  assert.equal(downloaded.size, (await stat(large)).size);
  assert.equal(await runCauseEffect(sha256File(downloaded.path)), await runCauseEffect(sha256File(large)));
  results.push({ check: "HTTP streaming upload and disk download preserve >100 MiB file", bytes: downloaded.size });

  const waitingForRange = new Promise<void>((resolve) => {
    heldRangeStarted = resolve;
  });
  const rangeClosed = new Promise<void>((resolve) => {
    heldRangeClosed = resolve;
  });
  let rangeRequests = 0;
  const cancellableRemote: RemoteRequestFn = (_server, path, decode, init) =>
    remoteCall((signal) => {
      rangeRequests += 1;
      const target = rangeRequests === 2 ? `${path}?waitForCancel=1` : path;
      return requestFor("owner", true, signal)(
        init?.method ?? "GET",
        target,
        decode,
        init?.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)),
      );
    });
  const cancelDirectory = join(root, "cancelled-download");
  const stop = Deferred.makeUnsafe<never, RemoteWorkflowError>();
  // This is the interruption boundary that RemoteServerManager.#stoppable owns. The downloader,
  // filesystem, first range and pending HTTP request are real.
  const pendingDownload = Effect.runPromise(
    Effect.result(
      Effect.raceFirst(
        downloadRemoteAttachmentToDisk(cancellableRemote, "host", uploaded.id, cancelDirectory),
        Deferred.await(stop),
      ),
    ),
  );
  await waitingForRange;
  assert.equal((await readdir(cancelDirectory)).filter((name) => name.endsWith(".part")).length, 1);
  Deferred.doneUnsafe(stop, Effect.fail(new RemoteWorkflowError({ cause: new AttachmentDownloadStopped() })));
  const cancelledDownload = await pendingDownload;
  assert.ok(Result.isFailure(cancelledDownload));
  assert.ok(cancelledDownload.failure.cause instanceof AttachmentDownloadStopped);
  await rangeClosed;
  assert.equal(rangeRequests, 2);
  assert.deepEqual(await readdir(cancelDirectory), []);
  results.push({ check: "download stop aborts the pending HTTP range and removes the partial file" });

  for (const name of ["sample.rar", "sample.7z", "sample.tar.gz", "program.exe", "no-extension", "empty"]) {
    const bytes = name === "empty" ? new Uint8Array() : new Uint8Array([0, 255, 12, 22]);
    let largestRead = 0;
    const attachment = await Effect.runPromise(
      uploadAttachmentStream(request, {
        name,
        mimeType: "text/plain",
        size: bytes.length,
        read: async (offset, length) => {
          largestRead = Math.max(largestRead, length);
          return bytes.subarray(offset, offset + length);
        },
      }).pipe(Effect.mapError((error) => error.cause)),
    );
    assert.ok(largestRead <= ATTACHMENT_CHUNK_BYTES);
    assert.equal(attachment.previewKind, "none");
    assert.equal(attachment.mimeType, "application/octet-stream");
    assert.equal(isOpenableAttachmentName(name), false);
  }
  results.push({ check: "all formats, unknown MIME safety, and empty files" });
  const session = await request("POST", STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadState, {
    name: "owner.bin",
    mimeType: "",
    size: 3,
  });
  const payload = { id: session.id, offset: 0, base64: "YWJj" };
  await assert.rejects(
    requestFor("other")("POST", STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadState, payload),
  );
  await assert.rejects(
    request("POST", STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadState, { ...payload, offset: 2 }),
  );
  await request("POST", STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadState, payload);
  await assert.rejects(request("POST", STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadState, payload));
  await assert.rejects(
    request("POST", STREAMING_ATTACHMENT_ROUTES.complete, (value) => value, { id: session.id, sha256: "0".repeat(64) }),
  );
  assert.equal((await readdir(directory)).includes(session.id), false);
  results.push({ check: "owner binding, offset and duplicate checks, hash failure cleanup" });

  const truncated = await request("POST", STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadState, {
    name: "short.bin",
    mimeType: "",
    size: 9,
  });
  await assert.rejects(
    request("POST", STREAMING_ATTACHMENT_ROUTES.complete, (value) => value, {
      id: truncated.id,
      sha256: createHash("sha256").digest("hex"),
    }),
  );
  const cancelled = await request("POST", STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadState, {
    name: "cancel.bin",
    mimeType: "",
    size: 10,
  });
  await request("POST", STREAMING_ATTACHMENT_ROUTES.cancel, () => undefined, { id: cancelled.id });
  assert.deepEqual(await readdir(directory), []);
  let cancelledDuringRead = false;
  await assert.rejects(
    Effect.runPromise(
      uploadAttachmentStream(
        request,
        {
          name: "cancel-before-write.bin",
          mimeType: "",
          size: 3,
          read: async () => {
            cancelledDuringRead = true;
            return new Uint8Array([1, 2, 3]);
          },
        },
        { isCancelled: () => cancelledDuringRead },
      ).pipe(Effect.mapError((error) => error.cause)),
    ),
  );
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(
    requestFor("owner", false)("POST", STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadState, {
      name: "legacy.zip",
      mimeType: "",
      size: 1,
    }),
  );
  assert.equal(isKnownAttachmentName("program.exe"), false);
  assert.equal(
    isSupportedAttachmentNameFor("program.exe", { eml: true, media: true, zip: true, mp4: true, svg: true }),
    false,
  );
  assert.throws(() =>
    decodeTeamProtocolV2FileControlFrame(
      JSON.stringify({
        version: 2,
        type: "file-open",
        transferId: "legacy",
        name: "large.zip",
        mimeType: "application/zip",
        size: 101 * 1024 * 1024,
        sha256: "0".repeat(64),
      }),
    ),
  );
  results.push({
    check: "truncation, cancellation before chunk submission, missing capability, and unchanged V2 ceiling",
  });

  const parallel = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      runCauseEffect(uploads.begin("quota", { name: "quota.bin", mimeType: "", size: 0 })),
    ),
  );
  assert.equal(parallel.filter((result) => result.status === "fulfilled").length, 10);
  for (const result of parallel)
    if (result.status === "fulfilled") await runCauseEffect(uploads.cancel("quota", result.value.id));
  const staleDirectory = join(root, "stale-uploads");
  const stale = join(staleDirectory, "00000000-0000-0000-0000-000000000000");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "partial.bin"), "partial");
  await utimes(stale, new Date(0), new Date(0));
  const restarted = new AttachmentUploadSessions(staleDirectory);
  const fresh = await runCauseEffect(restarted.begin("restart", { name: "new.bin", mimeType: "", size: 0 }));
  assert.equal((await readdir(staleDirectory)).includes("00000000-0000-0000-0000-000000000000"), false);
  await runCauseEffect(restarted.cancel("restart", fresh.id));
  await runCauseEffect(restarted.dispose());
  results.push({ check: "concurrent creation quota and stale crash-file cleanup" });
  const blockedDirectory = join(root, "blocked-uploads");
  await writeFile(blockedDirectory, "keep this file");
  const repaired = new AttachmentUploadSessions(blockedDirectory);
  await assert.rejects(runCauseEffect(repaired.begin("disk", { name: "file.bin", mimeType: "", size: 0 })));
  assert.equal(await readFile(blockedDirectory, "utf8"), "keep this file");
  await rename(blockedDirectory, `${blockedDirectory}.original`);
  const recovered = await runCauseEffect(repaired.begin("disk", { name: "file.bin", mimeType: "", size: 0 }));
  await runCauseEffect(repaired.cancel("disk", recovered.id));
  await runCauseEffect(repaired.dispose());
  assert.deepEqual(await readdir(blockedDirectory), []);
  results.push({ check: "filesystem failure preserves existing data and a repaired directory permits retry" });
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(
    artifact,
    JSON.stringify({ status: "pass", checks: results, maximumChunkBytes: ATTACHMENT_CHUNK_BYTES }, null, 2),
  );
  // Machine-readable: the smoke runner prints the report path only.
  process.stdout.write(`${artifact}\n`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runCauseEffect(uploads.dispose());
  await rm(root, { recursive: true, force: true });
}
