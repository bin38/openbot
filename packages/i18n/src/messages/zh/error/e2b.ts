import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/e2b";

export const messages = {
  "error.e2b.downloadFailed": "无法将云电脑文件交付到对话，请重试。",
  "error.e2b.keyMissing": "先在云电脑设置中添加 E2B API 密钥。",
  "error.e2b.keyUnreadable": "无法解密已保存的 E2B 密钥，请在云电脑设置中重新输入。",
  "error.e2b.storeUnreadable": "无法读取云电脑状态，原始文件已保留。",
  "error.e2b.storeWriteFailed": "云电脑状态保存失败，已有绑定未被替换。",
  "error.e2b.keyReplacement": "请确认更换 E2B 账户，已有云电脑绑定会保留。",
  "error.e2b.keyInUse": "请确认移除密钥。已有云电脑会保留，仍需要原 E2B 账户才能管理。",
  "error.e2b.busy": "云电脑操作正在进行，等待完成后再试。",
  "error.e2b.agentMissing": "此助手已不存在，无法为它创建云电脑。",
  "error.e2b.machineMissing": "该智能体还没有云电脑，请先启动一台。",
  "error.e2b.machineExpired": "E2B 中已不存在这台云电脑。原绑定已保留，删除绑定后才能新建。",
  "error.e2b.notRunning": "先启动或恢复这台云电脑，再使用它。",
  "error.e2b.humanControl": "用户正在控制这台云电脑，等待用户交还控制权。",
  "error.e2b.auth": "E2B 拒绝了该密钥或电脑访问权限，请检查云电脑设置中的账户。",
  "error.e2b.rateLimit": "已达到 E2B 账户或请求限制，请检查套餐并稍后重试。",
  "error.e2b.unavailable": "E2B 未能完成该操作。重试修改前，先检查电脑状态。",
  "error.e2b.filePath": "上传时选择此助手工作区中的普通文件；下载时填写不含路径的文件名。",
  "error.e2b.stream": "云电脑查看器操作失败。成功交还前，仍保持人工控制。",
  "error.e2b.viewerFailed": "无法打开云电脑查看器。",
  "error.e2b.declined": "用户拒绝了这次云电脑操作。",
  "error.e2b.invalidTemplate": "E2B 拒绝了该模板或创建配置，请检查云电脑设置中的模板。",
  "error.e2b.creationPending": "一次 E2B 创建结果未知。修改模板或账户前，请对列出的智能体重试启动以恢复结果。",
  "error.e2b.createCleanup": "新云电脑未能保存或停止。它会在 E2B 超时后暂停，重试前请检查 E2B 控制台。",
} as const satisfies PartialTranslation<typeof source>;
