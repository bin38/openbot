import { sha256 } from "@noble/hashes/sha2.js";
import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import {
  ATTACHMENT_CHUNK_BYTES,
  type BeginAttachmentUpload,
  decodeBeginAttachmentUpload,
  decodeWriteAttachmentUpload,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";

/** The preview validates chunks and digests without retaining entire uploaded files in memory. */
export function createMockAttachmentUploads(): Pick<
  OpenBotDesktopApi["agent"],
  "beginAttachmentUpload" | "writeAttachmentUpload" | "completeAttachmentUpload" | "cancelAttachmentUpload"
> {
  const uploads = new Map<
    string,
    { input: BeginAttachmentUpload; offset: number; digest: ReturnType<typeof sha256.create> }
  >();
  const requireUpload = (id: string) => {
    const upload = uploads.get(id);
    if (!upload) throw new Error("Attachment upload is no longer available.");
    return upload;
  };
  return {
    beginAttachmentUpload: async (raw) => {
      const input = decodeBeginAttachmentUpload(raw);
      const id = crypto.randomUUID();
      uploads.set(id, { input, offset: 0, digest: sha256.create() });
      return { id, offset: 0, chunkBytes: ATTACHMENT_CHUNK_BYTES };
    },
    writeAttachmentUpload: async (raw) => {
      const input = decodeWriteAttachmentUpload(raw);
      const upload = requireUpload(input.id);
      const bytes = Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0));
      if (input.offset !== upload.offset || bytes.length > upload.input.size - upload.offset)
        throw new Error("Invalid attachment upload offset.");
      upload.digest.update(bytes);
      upload.offset += bytes.length;
      return { id: input.id, offset: upload.offset, chunkBytes: ATTACHMENT_CHUNK_BYTES };
    },
    completeAttachmentUpload: async ({ id, sha256: expected }) => {
      const upload = requireUpload(id);
      uploads.delete(id);
      const digest = Array.from(upload.digest.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (upload.offset !== upload.input.size || digest !== expected)
        throw new Error("Attachment upload is incomplete.");
      return { id, ...upload.input, kind: "file", previewKind: "none", previewUrl: null };
    },
    cancelAttachmentUpload: async ({ id }) => {
      uploads.delete(id);
    },
  };
}
