import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/attachment";

export const messages = {
  // Attachment and file preview errors.
  "error.attachment.notFound": "未找到该附件。",
  "error.attachment.fileTooLarge": "某个文件超过了 100 MB 上限。",
  "error.attachment.totalTooLarge": "附件总量超过了 250 MB 上限。",
  "error.attachment.unavailable": "该文件已不可用。",
  "error.attachment.tooMany": "最多只能选择 {limit} 个文件。",
  "error.attachment.mediaUnsupported": "该服务器不支持 MP3 或 MOV 附件。请更新主机上的 OpenBot 后重试。",
  "error.attachment.emlUnsupported": "该服务器不支持 EML 附件。请更新主机上的 OpenBot 后重试。",
  "error.attachment.zipUnsupported": "该服务器不支持 ZIP 附件。请更新主机上的 OpenBot 后重试。",
  "error.attachment.mp4Unsupported": "该服务器不支持 MP4 附件。请更新主机上的 OpenBot 后重试。",
  "error.attachment.svgUnsupported": "该服务器不支持 SVG 附件。请更新主机上的 OpenBot 后重试。",
  "error.attachment.uploadBusy": "此上传正在处理其他操作，完成后可重试。",
  "error.attachment.uploadOffset": "上传分块与预期文件位置不一致，请重新上传该文件。",
  "error.attachment.uploadWriteFailed": "无法写入文件，请检查剩余磁盘空间。",
  "error.attachment.uploadIncomplete": "上传结束时文件尚未传完整，请重新上传。",
  "error.attachment.uploadDigest": "上传文件未通过完整性校验，请重新上传。",
  "error.attachment.uploadUnavailable": "此上传已过期或属于其他会话，请重新上传文件。",
  "error.attachment.streamingUnsupported": "此主机需要更新 OpenBot 才能接收该文件类型或大于 100 MB 的文件。",
  "error.attachment.downloadChanged": "文件在下载期间发生变化，请重新下载。",
  "error.attachment.browserStreamingUnavailable":
    "此浏览器无法将下载流式写入磁盘，请使用新版桌面浏览器或 OpenBot 桌面版。",
  "error.attachment.previewTooLarge": "该文件超过了 100 MB 上限。",
} as const satisfies PartialTranslation<typeof source>;
