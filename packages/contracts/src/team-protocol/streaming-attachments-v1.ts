// Additive transfer protocol. Chunks are bounded; a file has no application size ceiling.
import { isDynamicRecord } from "../runtime-values";
import { adminRoute, count, fields, identifier, nullable, type OptionalRouteCodec, oneOf, string } from "./admin-wire";

export const STREAMING_ATTACHMENTS_CAPABILITY = "streaming-attachments-v1";
export const ATTACHMENT_CHUNK_BYTES = 192 * 1024;
export const ATTACHMENT_CHUNK_BASE64 = (ATTACHMENT_CHUNK_BYTES / 3) * 4;
export const STREAMING_ATTACHMENT_ROUTES = {
  begin: "/v1/attachment-uploads/begin",
  write: "/v1/attachment-uploads/write",
  complete: "/v1/attachment-uploads/complete",
  cancel: "/v1/attachment-uploads/cancel",
  read: "/v1/attachment-uploads/read",
} as const;

export type BeginAttachmentUpload = { name: string; mimeType: string; size: number };
export type AttachmentUploadId = { id: string };
export type WriteAttachmentUpload = { id: string; offset: number; base64: string };
export type CompleteAttachmentUpload = { id: string; sha256: string };
export type AttachmentUploadState = { id: string; offset: number; chunkBytes: number };
export type ReadAttachmentChunk = { id: string; offset: number };
export type AttachmentChunk = {
  name: string;
  mimeType: string;
  size: number;
  offset: number;
  base64: string;
  revision: string;
};

function record(value: unknown) {
  if (!isDynamicRecord(value)) throw new Error("Invalid attachment upload.");
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error("Invalid attachment upload text.");
  return value;
}
function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid attachment upload size.");
  return value;
}
function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/u.test(result)) throw new Error("Invalid attachment upload identifier.");
  return result;
}
export function decodeBeginAttachmentUpload(value: unknown): BeginAttachmentUpload {
  const input = record(value);
  const name = text(input.name, 1_024);
  if (!name || name === "." || name === ".." || /[\\/\p{Cc}]/u.test(name))
    throw new Error("Invalid attachment upload filename.");
  return { name, mimeType: text(input.mimeType, 256), size: size(input.size) };
}
export function decodeAttachmentUploadId(value: unknown): AttachmentUploadId {
  return { id: id(record(value).id) };
}
export function decodeWriteAttachmentUpload(value: unknown): WriteAttachmentUpload {
  const input = record(value);
  const base64 = text(input.base64, ATTACHMENT_CHUNK_BASE64);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))
    throw new Error("Invalid attachment upload chunk.");
  return { id: id(input.id), offset: size(input.offset), base64 };
}
export function decodeCompleteAttachmentUpload(value: unknown): CompleteAttachmentUpload {
  const input = record(value);
  const sha256 = text(input.sha256, 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid attachment upload digest.");
  return { id: id(input.id), sha256 };
}
export function decodeAttachmentUploadState(value: unknown): AttachmentUploadState {
  const input = record(value);
  if (input.chunkBytes !== ATTACHMENT_CHUNK_BYTES) throw new Error("Invalid attachment upload chunk size.");
  return { id: id(input.id), offset: size(input.offset), chunkBytes: ATTACHMENT_CHUNK_BYTES };
}
export function decodeReadAttachmentChunk(value: unknown): ReadAttachmentChunk {
  const input = record(value);
  return { id: id(input.id), offset: size(input.offset) };
}
export function decodeAttachmentChunk(value: unknown): AttachmentChunk {
  const input = record(value);
  const base64 = text(input.base64, ATTACHMENT_CHUNK_BASE64);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))
    throw new Error("Invalid attachment download chunk.");
  return {
    name: text(input.name, 1_024),
    mimeType: text(input.mimeType, 256),
    size: size(input.size),
    offset: size(input.offset),
    base64,
    revision: text(input.revision, 256),
  };
}

const uploadId = fields({ id: identifier });
const uploadState = fields({ id: identifier, offset: count, chunkBytes: count });
const attachment = fields({
  id: identifier,
  name: string(1_024),
  size: count,
  kind: oneOf("image", "file"),
  mimeType: string(256),
  previewKind: oneOf("image", "pdf", "text", "none"),
  previewUrl: nullable(string(8_192)),
});
export const STREAMING_ATTACHMENT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    STREAMING_ATTACHMENT_ROUTES.begin,
    adminRoute(fields({ name: string(1_024), mimeType: string(256), size: count }), uploadState),
  ],
  [
    STREAMING_ATTACHMENT_ROUTES.write,
    adminRoute(fields({ id: identifier, offset: count, base64: string(ATTACHMENT_CHUNK_BASE64) }), uploadState),
  ],
  [STREAMING_ATTACHMENT_ROUTES.complete, adminRoute(fields({ id: identifier, sha256: string(64) }), attachment)],
  [STREAMING_ATTACHMENT_ROUTES.cancel, adminRoute(uploadId, nullable(fields({})))],
  [
    STREAMING_ATTACHMENT_ROUTES.read,
    adminRoute(
      fields({ id: identifier, offset: count }),
      fields({
        name: string(1_024),
        mimeType: string(256),
        size: count,
        offset: count,
        base64: string(ATTACHMENT_CHUNK_BASE64),
        revision: string(256),
      }),
    ),
  ],
]);
