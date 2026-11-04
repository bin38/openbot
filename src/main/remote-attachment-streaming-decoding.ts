import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentUploadState,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";

/** The remote host is untrusted. This decoder is independent of the main-to-preload boundary. */
export function decodeAttachmentUploadStateFromHost(value: unknown): AttachmentUploadState {
  if (!isDynamicRecord(value)) throw new Error("The host returned invalid upload data.");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/u.test(value.id)
  )
    throw new Error("The host returned an invalid upload identifier.");
  if (
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.chunkBytes !== ATTACHMENT_CHUNK_BYTES
  )
    throw new Error("The host returned an invalid upload position.");
  return { id: value.id, offset: value.offset, chunkBytes: ATTACHMENT_CHUNK_BYTES };
}
