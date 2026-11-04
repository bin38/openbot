import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/apiChannel";
export const messages = {
  "error.apiChannel.declined": "此 API 操作未获批准。除非用户重新要求，否则不要重试。",
  "error.apiChannel.invalid": "API 渠道配置无效。检查地址、操作、参数和 JSON 请求模板。",
  "error.apiChannel.storage": "无法读取或保存 API 渠道存储，已有数据已保留。",
  "error.apiChannel.credential": "启用渠道前，先保存可读取的 API 凭据。",
  "error.apiChannel.origin": "API 地址所属站点改变后，需要重新输入凭据；原凭据不会发送到新站点。",
  "error.apiChannel.unavailable": "此 API 渠道或操作不存在，或尚未启用。",
  "error.apiChannel.parameters": "API 输入与操作参数不匹配。检查必填项和 JSON 数据类型。",
  "error.apiChannel.file": "此 API 操作需要调用助手允许访问的工作区中的普通文件。",
  "error.apiChannel.request": "API 请求未完成。不要自动重复生成或写入请求，先检查已有运行记录。",
  "error.apiChannel.http": "API 返回 HTTP {status}。检查此渠道的凭据和服务权限。",
  "error.apiChannel.business": "API 返回失败代码 {code}。检查服务账号、套餐权限和请求参数。",
  "error.apiChannel.response": "API 返回内容与配置格式不符，或内容过大，无法安全读取。",
  "error.apiChannel.run": "此 API 运行记录不可用、属于其他助手，或渠道配置已改变。",
  "error.apiChannel.artifact": "无法取得 API 产物。检查允许的下载域名，以及结果是否已过期。",
  "error.apiChannel.pending": "API 任务仍在运行。使用运行 ID 查询进度，不要再次提交生成请求。",
  "error.apiChannel.failed": "API 任务失败或已取消，已有结果已保留。",
} as const satisfies PartialTranslation<typeof source>;
