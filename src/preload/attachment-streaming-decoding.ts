import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentUploadState,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";

export function decodeAttachmentUploadStateFromMain(value: unknown): AttachmentUploadState {
  if (
    !isDynamicRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.id) ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.chunkBytes !== ATTACHMENT_CHUNK_BYTES
  )
    throw new Error("Invalid attachment upload state from main.");
  return { id: value.id, offset: value.offset, chunkBytes: ATTACHMENT_CHUNK_BYTES };
}
