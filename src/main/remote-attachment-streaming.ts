import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentChunk,
  decodeAttachmentChunk,
  STREAMING_ATTACHMENT_ROUTES,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { decodeDraftAttachment } from "./remote-agent-decoding";
import { decodeAttachmentUploadStateFromHost } from "./remote-attachment-streaming-decoding";
import { decodeVoid } from "./remote-host-decoding";
import type { RemoteRequestFn } from "./remote-server-client";
import { type RemoteFileProgress, RemoteWorkflowError, remoteCall } from "./remote-service-effects";

/** Existing byte-only IPC callers stay bounded, and use the same current-host transfer contract. */
export const uploadRemoteAttachmentBytes = Effect.fn("RemoteAttachments.uploadBytes")(function* (
  request: RemoteRequestFn,
  serverId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  progress?: (sent: number, total: number) => void,
) {
  const session = yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadStateFromHost, {
    method: "POST",
    body: { name, mimeType, size: bytes.length },
  });
  return yield* Effect.gen(function* () {
    const digest = createHash("sha256");
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
      const state = yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadStateFromHost, {
        method: "POST",
        body: { id: session.id, offset, base64: Buffer.from(chunk).toString("base64") },
      });
      if (state.id !== session.id || state.offset !== offset + chunk.length)
        return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.attachment.uploadOffset")) });
      digest.update(chunk);
      progress?.(offset + chunk.length, bytes.length);
    }
    return yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.complete, decodeDraftAttachment, {
      method: "POST",
      body: { id: session.id, sha256: digest.digest("hex") },
    });
  }).pipe(
    Effect.ensuring(
      request(serverId, STREAMING_ATTACHMENT_ROUTES.cancel, decodeVoid, {
        method: "POST",
        body: { id: session.id },
      }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

/** Reads a selected file through one handle, so path replacement cannot change the upload mid-flight. */
export const uploadRemoteAttachmentPath = Effect.fn("RemoteAttachments.uploadPath")(
  (request: RemoteRequestFn, serverId: string, path: string, progress?: (sent: number, total: number) => void) =>
    Effect.acquireUseRelease(
      remoteCall(() => open(path, "r")),
      (file) =>
        Effect.gen(function* () {
          const before = yield* remoteCall(() => file.stat());
          if (!before.isFile())
            return yield* new RemoteWorkflowError({ cause: new Error("An attachment must be a regular file.") });
          const session = yield* request(
            serverId,
            STREAMING_ATTACHMENT_ROUTES.begin,
            decodeAttachmentUploadStateFromHost,
            {
              method: "POST",
              body: { name: basename(path), mimeType: attachmentMimeTypeForName(path), size: before.size },
            },
          );
          return yield* Effect.gen(function* () {
            const digest = createHash("sha256");
            const buffer = Buffer.allocUnsafe(ATTACHMENT_CHUNK_BYTES);
            let offset = 0;
            while (offset < before.size) {
              const length = Math.min(buffer.length, before.size - offset);
              const { bytesRead } = yield* remoteCall(() => file.read(buffer, 0, length, offset));
              if (bytesRead !== length)
                return yield* new RemoteWorkflowError({
                  cause: new Error(sourceText("error.attachment.uploadIncomplete")),
                });
              const bytes = buffer.subarray(0, bytesRead);
              const state = yield* request(
                serverId,
                STREAMING_ATTACHMENT_ROUTES.write,
                decodeAttachmentUploadStateFromHost,
                {
                  method: "POST",
                  body: { id: session.id, offset, base64: bytes.toString("base64") },
                },
              );
              if (state.id !== session.id || state.offset !== offset + bytesRead)
                return yield* new RemoteWorkflowError({
                  cause: new Error(sourceText("error.attachment.uploadOffset")),
                });
              digest.update(bytes);
              offset += bytesRead;
              progress?.(offset, before.size);
            }
            const after = yield* remoteCall(() => file.stat());
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
              return yield* new RemoteWorkflowError({
                cause: new Error(sourceText("error.attachment.downloadChanged")),
              });
            return yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.complete, decodeDraftAttachment, {
              method: "POST",
              body: { id: session.id, sha256: digest.digest("hex") },
            });
          }).pipe(
            Effect.ensuring(
              request(serverId, STREAMING_ATTACHMENT_ROUTES.cancel, decodeVoid, {
                method: "POST",
                body: { id: session.id },
              }).pipe(Effect.catch(() => Effect.void)),
            ),
          );
        }),
      (file) => remoteCall(() => file.close()).pipe(Effect.orDie),
    ),
);

/** Current hosts send bounded JSON ranges over both HTTPS and WebRTC, never one large file frame. */
export const downloadRemoteAttachmentToDisk = Effect.fn("RemoteAttachments.downloadToDisk")(function* (
  request: RemoteRequestFn,
  serverId: string,
  attachmentId: string,
  directory: string,
  progress?: RemoteFileProgress,
) {
  yield* remoteCall(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  const first = yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.read, decodeAttachmentChunk, {
    method: "POST",
    body: { id: attachmentId, offset: 0 },
  });
  const name =
    basename(first.name)
      .replace(/[<>:"|?*\p{Cc}\\/]/gu, "-")
      .replace(/[. ]+$/u, "") || "attachment";
  const path = join(directory, `${randomUUID()}-${name}`);
  const partial = `${path}.part`;
  let complete = false;
  return yield* Effect.acquireUseRelease(
    remoteCall(() => open(partial, "wx", 0o600)),
    (file) =>
      Effect.gen(function* () {
        let offset = 0;
        let chunk = first;
        do {
          const bytes = yield* checkedChunk(chunk, first, offset);
          yield* writeAll(file, bytes, offset);
          offset += bytes.length;
          progress?.onProgress(offset, first.size);
          if (offset === first.size) break;
          chunk = yield* request(serverId, STREAMING_ATTACHMENT_ROUTES.read, decodeAttachmentChunk, {
            method: "POST",
            body: { id: attachmentId, offset },
          });
        } while (offset < first.size);
        yield* remoteCall(() => file.sync());
        return { path, name, mimeType: first.mimeType, size: first.size };
      }),
    (file) => remoteCall(() => file.close()).pipe(Effect.orDie),
  ).pipe(
    Effect.tap(() =>
      remoteCall(async () => {
        await rename(partial, path);
        complete = true;
      }),
    ),
    Effect.ensuring(
      remoteCall(async () => {
        if (!complete) await rm(partial, { force: true });
      }).pipe(Effect.orDie),
    ),
  );
});

function checkedChunk(chunk: AttachmentChunk, first: AttachmentChunk, offset: number) {
  return remoteCall(async () => {
    const bytes = Buffer.from(chunk.base64, "base64");
    if (
      chunk.offset !== offset ||
      chunk.size !== first.size ||
      chunk.name !== first.name ||
      chunk.revision !== first.revision ||
      bytes.length !== Math.min(ATTACHMENT_CHUNK_BYTES, first.size - offset) ||
      bytes.toString("base64") !== chunk.base64
    )
      throw new Error(sourceText("error.attachment.downloadChanged"));
    return bytes;
  });
}
function writeAll(file: FileHandle, bytes: Uint8Array, offset: number) {
  return remoteCall(async () => {
    let written = 0;
    while (written < bytes.length) {
      const result = await file.write(bytes, written, bytes.length - written, offset + written);
      if (result.bytesWritten === 0) throw new Error(sourceText("error.attachment.uploadWriteFailed"));
      written += result.bytesWritten;
    }
  });
}
