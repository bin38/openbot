import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/colab";
export const messages = {
  "error.colab.missing": "请在这台电脑安装官方 Google Colab CLI 后重试。",
  "error.colab.authRequired": "请先在服务器设置中登录 Colab，再使用此操作。",
  "error.colab.loginPending": "Colab 正在登录，请先完成或取消该登录。",
  "error.colab.loginFailed": "Colab 登录未完成，请检查 Google 授权后重试。",
  "error.colab.commandFailed": "Colab CLI 操作失败，请检查运行时、Google 账号和应用内代理。",
  "error.colab.timeout": "Colab 请求超时，远端代码可能仍在运行。",
  "error.colab.cancelled": "本机 Colab 请求已取消，远端代码可能仍在运行。",
  "error.colab.invalid": "Colab 请求无效。",
  "error.colab.file": "无法使用此 Colab 文件，请选择获准的工作区普通文件。",
  "error.colab.fileExists": "输出文件已存在，请换一个名称。",
  "error.colab.sessionMissing": "未找到这个 Colab 运行时，请刷新列表并选择仍在运行的会话。",
  "error.colab.proxy": "Colab CLI 无法连接应用内代理，请检查 Gemini 代理设置。",
  "error.colab.allocation": "Colab 暂时无法分配运行时，请检查现有会话、额度和资源供应后重试。",
} as const satisfies PartialTranslation<typeof source>;
