import { open } from "node:fs/promises";
import {
  ATTACHMENT_CHUNK_BYTES,
  decodeAttachmentUploadId,
  decodeBeginAttachmentUpload,
  decodeCompleteAttachmentUpload,
  decodeReadAttachmentChunk,
  decodeWriteAttachmentUpload,
  STREAMING_ATTACHMENT_ROUTES,
  STREAMING_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { sourceText } from "@openbot/i18n/source";
import type { AttachmentUploadSessions } from "../../backend/attachment-upload-sessions";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents, TeamApiMailbox } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

export interface AttachmentUploadRouteDependencies {
  agents: Pick<TeamApiAgents, "prepareImportedAttachments">;
  mailbox: TeamApiMailbox;
  uploads: AttachmentUploadSessions;
}

export async function routeAttachmentUploads(
  context: TeamApiRequestContext,
  { agents, mailbox, uploads }: AttachmentUploadRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, json } = context;
  if (method !== "POST" || !Object.values(STREAMING_ATTACHMENT_ROUTES).some((path) => path === url.pathname))
    return "unmatched";
  if (!context.capabilities.has(STREAMING_ATTACHMENTS_CAPABILITY))
    throw new HttpError(409, sourceText("error.attachment.streamingUnsupported"));
  const owner = `team:${context.member.id}:${context.sessionId}`;
  const body = await readJson(request);
  if (url.pathname === STREAMING_ATTACHMENT_ROUTES.begin)
    return json(201, await runCauseEffect(uploads.begin(owner, decodeBeginAttachmentUpload(body))));
  if (url.pathname === STREAMING_ATTACHMENT_ROUTES.write)
    return json(200, await runCauseEffect(uploads.write(owner, decodeWriteAttachmentUpload(body))));
  if (url.pathname === STREAMING_ATTACHMENT_ROUTES.cancel) {
    await runCauseEffect(uploads.cancel(owner, decodeAttachmentUploadId(body).id));
    return context.empty(204);
  }
  if (url.pathname === STREAMING_ATTACHMENT_ROUTES.complete) {
    const input = decodeCompleteAttachmentUpload(body);
    const path = await runCauseEffect(uploads.finish(owner, input));
    try {
      const [attachment] = await runCauseEffect(agents.prepareImportedAttachments([path], []));
      if (!attachment) throw new Error("The attachment was not prepared.");
      return json(201, attachment);
    } finally {
      await runCauseEffect(uploads.cancel(owner, input.id));
    }
  }
  if (url.pathname === STREAMING_ATTACHMENT_ROUTES.read) {
    const input = decodeReadAttachmentChunk(body);
    const attachment = await runCauseEffect(mailbox.resolveAttachment(input.id));
    if (!attachment) throw new HttpError(404, sourceText("error.attachment.notFound"));
    const file = await open(attachment.path, "r");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || input.offset > metadata.size) throw new HttpError(400, "Invalid file offset.");
      const bytes = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, metadata.size - input.offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, input.offset);
      if (bytesRead !== bytes.length) throw new HttpError(409, sourceText("error.attachment.downloadChanged"));
      return json(200, {
        name: attachment.name,
        mimeType: attachment.mimeType || "application/octet-stream",
        size: metadata.size,
        offset: input.offset,
        base64: bytes.toString("base64"),
        revision: `${metadata.size}:${metadata.mtimeMs}:${metadata.ino}`,
      });
    } finally {
      await file.close();
    }
  }
  return "unmatched";
}
