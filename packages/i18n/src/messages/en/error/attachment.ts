import { defineMessages } from "../../../message";

export const messages = defineMessages("error.attachment", {
  // Attachment and file preview errors.
  "error.attachment.notFound": "Attachment was not found.",
  "error.attachment.fileTooLarge": "A file exceeds the 100 MB limit.",
  "error.attachment.totalTooLarge": "Attachments exceed the 250 MB total limit.",
  "error.attachment.unavailable": "This file is no longer available.",
  "error.attachment.tooMany": "Choose at most {limit} files.",
  "error.attachment.mediaUnsupported":
    "This server does not support MP3 or MOV attachments. Update OpenBot on the host and retry.",
  "error.attachment.emlUnsupported":
    "This server does not support EML attachments. Update OpenBot on the host and retry.",
  "error.attachment.zipUnsupported":
    "This server does not support ZIP attachments. Update OpenBot on the host and retry.",
  "error.attachment.mp4Unsupported":
    "This server does not support MP4 attachments. Update OpenBot on the host and retry.",
  "error.attachment.svgUnsupported":
    "This server does not support SVG attachments. Update OpenBot on the host and retry.",
  "error.attachment.uploadBusy": "Another operation is using this upload. Retry when it finishes.",
  "error.attachment.uploadOffset": "The uploaded chunk does not match the expected file position. Retry the file.",
  "error.attachment.uploadWriteFailed": "The file could not be written. Check the available disk space.",
  "error.attachment.uploadIncomplete": "The upload ended before the whole file arrived. Retry the file.",
  "error.attachment.uploadDigest": "The uploaded file failed its integrity check. Retry the file.",
  "error.attachment.uploadUnavailable": "This upload expired or belongs to another session. Retry the file.",
  "error.attachment.streamingUnsupported":
    "This host needs an OpenBot update to accept this file type or a file larger than 100 MB.",
  "error.attachment.downloadChanged": "The file changed during download. Download it again.",
  "error.attachment.browserStreamingUnavailable":
    "This browser cannot stream downloads to disk. Use a current desktop browser or the OpenBot desktop app.",
  "error.attachment.previewTooLarge": "The file exceeds the 100 MB limit.",
});
