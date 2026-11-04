import {
  decodeAttachmentChunk,
  STREAMING_ATTACHMENT_ROUTES,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { sourceText } from "@openbot/i18n/source";
import { downloadAttachmentStream } from "@openbot/team-client/attachment-streaming";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { Effect } from "effect";

declare global {
  interface Window {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  }
}

/** Downloads to disk. Browsers without a save picker use a disk-backed origin-private file. */
export async function saveStreamingWebAttachment(
  request: TeamApiRequest,
  attachmentId: string,
): Promise<(() => Promise<void>) | null> {
  const suggestion = await request("POST", STREAMING_ATTACHMENT_ROUTES.read, decodeAttachmentChunk, {
    id: attachmentId,
    offset: 0,
  });
  let temporary: { directory: FileSystemDirectoryHandle; name: string } | null = null;
  let handle: FileSystemFileHandle;
  if (window.showSaveFilePicker && navigator.userActivation?.isActive) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: suggestion.name });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  } else {
    if (!navigator.storage?.getDirectory) throw new Error(sourceText("error.attachment.browserStreamingUnavailable"));
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("openbot-attachment-downloads", { create: true });
    const name = crypto.randomUUID();
    handle = await directory.getFileHandle(name, { create: true });
    temporary = { directory, name };
  }
  const writer = await handle.createWritable();
  try {
    const metadata = await Effect.runPromise(
      downloadAttachmentStream(request, attachmentId, async (bytes) => {
        await writer.write(new Uint8Array(bytes));
      }).pipe(Effect.mapError((error) => error.cause)),
    );
    await writer.close();
    if (!temporary) return null;
    const owned = temporary;
    const url = URL.createObjectURL(await handle.getFile());
    const link = document.createElement("a");
    link.href = url;
    link.download = metadata.name;
    link.click();
    // Keep the file and URL alive until this workspace is disposed, as ordinary download URLs are.
    return async () => {
      URL.revokeObjectURL(url);
      await owned.directory.removeEntry(owned.name);
    };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    if (temporary) await temporary.directory.removeEntry(temporary.name).catch(() => undefined);
    throw error;
  }
}
