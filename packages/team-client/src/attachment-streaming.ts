import { sha256 } from "@noble/hashes/sha2.js";
import { type AttachmentSummary, isAttachmentSummary } from "@openbot/contracts/ipc";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentChunk,
  decodeAttachmentChunk,
  decodeAttachmentUploadState,
  STREAMING_ATTACHMENT_ROUTES,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { type TeamApiRequest, TeamRequestError } from "./team-api-requests";

export interface AttachmentByteSource {
  name: string;
  mimeType: string;
  size: number;
  read: (offset: number, length: number) => Promise<Uint8Array>;
}
export interface AttachmentStreamOptions {
  isCancelled?: () => boolean;
  onProgress?: (transferred: number, total: number) => void;
}
const call = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new TeamRequestError({ cause }) });

function assertActive(options: AttachmentStreamOptions): void {
  if (options.isCancelled?.()) throw new Error(sourceText("error.remote.uploadCancelled"));
}
function attachment(value: unknown): AttachmentSummary {
  if (!isAttachmentSummary(value)) throw new Error("Invalid uploaded attachment.");
  return value;
}
function ignored(): void {}

/** The source reads one bounded range at a time; no File, DOM, or native filesystem is assumed. */
export const uploadAttachmentStream = Effect.fn("TeamClient.uploadAttachmentStream")(function* (
  request: TeamApiRequest,
  source: AttachmentByteSource,
  options: AttachmentStreamOptions = {},
) {
  yield* call(async () => assertActive(options));
  const session = yield* call(() =>
    request("POST", STREAMING_ATTACHMENT_ROUTES.begin, decodeAttachmentUploadState, {
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
    }),
  );
  return yield* Effect.gen(function* () {
    const digest = sha256.create();
    let offset = 0;
    while (offset < source.size) {
      const bytes = yield* call(async () => {
        assertActive(options);
        return source.read(offset, Math.min(ATTACHMENT_CHUNK_BYTES, source.size - offset));
      });
      if (bytes.length !== Math.min(ATTACHMENT_CHUNK_BYTES, source.size - offset))
        return yield* new TeamRequestError({ cause: new Error(sourceText("error.attachment.uploadIncomplete")) });
      const progress = yield* call(() => {
        assertActive(options);
        return request("POST", STREAMING_ATTACHMENT_ROUTES.write, decodeAttachmentUploadState, {
          id: session.id,
          offset,
          base64: bytesToBase64(bytes),
        });
      });
      if (progress.id !== session.id || progress.offset !== offset + bytes.length)
        return yield* new TeamRequestError({ cause: new Error(sourceText("error.attachment.uploadOffset")) });
      digest.update(bytes);
      offset += bytes.length;
      options.onProgress?.(offset, source.size);
    }
    yield* call(async () => assertActive(options));
    return yield* call(() =>
      request("POST", STREAMING_ATTACHMENT_ROUTES.complete, attachment, {
        id: session.id,
        sha256: Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      }),
    );
  }).pipe(
    Effect.ensuring(
      call(() => request("POST", STREAMING_ATTACHMENT_ROUTES.cancel, ignored, { id: session.id })).pipe(
        Effect.catch(() => Effect.void),
      ),
    ),
  );
});

/** Writes each verified range to a caller-owned sink; the caller handles publishing or aborting it. */
export const downloadAttachmentStream = Effect.fn("TeamClient.downloadAttachmentStream")(function* (
  request: TeamApiRequest,
  id: string,
  write: (bytes: Uint8Array, metadata: AttachmentChunk) => Promise<void>,
  options: AttachmentStreamOptions = {},
) {
  let offset = 0;
  let first: AttachmentChunk | null = null;
  do {
    yield* call(async () => assertActive(options));
    const chunk = yield* call(() =>
      request("POST", STREAMING_ATTACHMENT_ROUTES.read, decodeAttachmentChunk, { id, offset }),
    );
    const bytes = base64ToBytes(chunk.base64);
    if (
      chunk.offset !== offset ||
      bytes.length !== Math.min(ATTACHMENT_CHUNK_BYTES, chunk.size - offset) ||
      (first !== null && (first.revision !== chunk.revision || first.name !== chunk.name || first.size !== chunk.size))
    )
      return yield* new TeamRequestError({ cause: new Error(sourceText("error.attachment.downloadChanged")) });
    first ??= chunk;
    yield* call(() => write(bytes, chunk));
    offset += bytes.length;
    options.onProgress?.(offset, chunk.size);
  } while (offset < first.size);
  return { name: first.name, mimeType: first.mimeType, size: first.size };
});
