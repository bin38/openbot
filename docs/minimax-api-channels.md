# 自定义 API 渠道与 MiniMax 接入

自定义模型服务商用于聊天模型，自定义 API 渠道用于任意已配置的 HTTP 操作，例如语音识别、文字提取、
语音合成、图片生成、视频任务和文件管理。两者可以并存；添加 MiniMax API 渠道不需要改变本机 Codex 默认模型。

预置只包含地址、请求结构和结果提取规则，不含密钥，也不会在导入时执行请求。实际调用仍需要保存正确的
凭据、启用渠道、填写输入，并符合该服务的账号权限和使用限制。不要把“接口已配置”当作“所有能力已实测成功”。

## 用 AI 帮助配置渠道

可以把公开接口文档给助手，并说明用途，例如：

> 按这份接口文档创建一个语音识别渠道。使用 multipart 上传音频，返回 text 字段。
> 先生成配置供我检查，不要运行识别，也不要把密钥写进请求模板。

或：

> 创建一个 OCR 渠道，基础地址是我指定的 HTTPS 服务。请求方法、路径、字段和鉴权方式按文档填写。
> 我会在渠道设置中填写密钥，创建后保持停用。

检查配置中的基础地址、操作路径、上传字段、响应路径和下载域名，再在应用的凭据字段中保存密钥。
密钥不属于 JSON 模板、公共请求头、参数默认值或提示词。更换服务地址不代表可以把旧服务的密钥发送到新地址。

## 模板结构

每个渠道包含固定基础地址和鉴权方式，每个操作包含方法、相对路径、参数、请求体和响应规则：

| 配置项 | 作用 |
| --- | --- |
| `baseUrl` | 服务的基础地址，例如 `https://api.minimax.cn`。 |
| `auth` | 无鉴权、Bearer、指定请求头或查询参数鉴权；真实凭据单独保存。 |
| `headers` | 无密钥的公共请求头，例如协议版本。 |
| `path` / `query` | 相对接口路径和查询参数，可引用已声明的参数。 |
| `parameters` | 字符串、数字、布尔、JSON 或文件参数；`defaultJson` 是 JSON 字面量。 |
| `parameters[].fileEncoding` | JSON 请求中的文件可选 `data-url` 或 `base64`；multipart 则流式发送文件。 |
| `bodyType` | 无请求体、JSON 或 multipart。 |
| `body` | JSON 模板；完整值 `{{payload}}` 会保留 JSON 参数的对象/数组类型。 |
| `response` | JSON、文本或文件结果，业务错误、任务状态和产物提取规则。 |
| `job` | 将创建请求返回的任务 ID 绑定到同一渠道的查询操作。 |
| `artifactHosts` | 允许下载产物的准确主机或指定域名后缀，不使用任意通配符。 |

结果路径使用点分隔，例如 `choices.0.message.content`、`data.audio` 或 `task.content.url`。
图片数组可直接使用 `data.image_urls`；每个结果分别处理。下载规则可以选择 URL、hex 或 Base64。
产物请求不会转发渠道的鉴权信息。

`file` 参数用于安全文件上传。例如 ASR 的 multipart 模板为：

```json
{
  "model": "asr-1.0",
  "file": "{{file}}",
  "response_format": "json",
  "stream": false
}
```

不要手动填写 multipart 的 boundary，也不要把文件路径伪装成普通字符串要求服务端读取本机文件。
服务只能收到实际上传的数据。特殊 OCR 服务可能要求 URL、Base64、multipart 或异步任务，需按其文档修改模板，
不能仅更换域名就认为协议相同。

对于 JSON 图片接口，把参数类型设为 `file`，并设置 `fileEncoding: "data-url"` 或 `"base64"`。
请求体引用 `{{image}}` 时，执行器读取当前工作区的安全文件句柄并替换为实际图片内容，不发送本机路径。
JSON 内嵌文件的总量保护上限为 16 MiB；服务商可能有更小的限制。大文件应选择上游支持的 multipart 或文件上传接口。
MiniMax 模板提供“工作区图片文字提取”，通用 OCR 模板提供“识别工作区图片（Base64）”；后者的 `image_base64`
和 `text` 字段是示例，需要按目标服务修改。

## MiniMax 预置范围

预置依据 2026 年 11 月 4 日查阅的官方文档。中国区普通接口基址为 `https://api.minimax.cn`。
完整模板使用 Bearer 鉴权；Messages 兼容协议使用单独模板和 `x-api-key`。订阅用量位于另一个官方 origin，
也使用单独模板，不从普通 API 渠道自动跨 origin 转发密钥。

| 模板 | 范围 |
| --- | --- |
| MiniMax 中国区完整 HTTP 接口 | 模型目录、Chat Completions、Responses、Token 估算、搜索、视觉文字提取、ASR、同步/异步语音、音色、图像、视频和文件管理。 |
| MiniMax Messages 兼容接口 | `/anthropic/v1/messages` 和 Token 估算。协议兼容不等于调用 Claude 账号。 |
| MiniMax 订阅用量 | 只读查询 `https://www.minimax.cn/v1/token_plan/remains`，不购买或升级套餐。 |
| 通用 OpenAI 兼容 ASR | `/v1/audio/transcriptions` 的 multipart 示例，保存前改成自己的服务。 |
| 通用 OCR / JSON API | 可编辑 JSON 请求示例，`api.example.com` 是占位地址，不是真实 OCR 服务。 |

MiniMax 主模板中的操作如下：

| 操作 | HTTP 接口与结果 |
| --- | --- |
| 模型列表、模型详情 | `GET /v1/models`、`GET /v1/models/{model_id}`。目录不保证账号有权调用每个模型。 |
| 文本、多模态对话 | `POST /v1/chat/completions`、`POST /v1/responses`；优先使用 `MiniMax-M3.1-Flash`。 |
| 旧文本兼容入口 | `POST /v1/text/chatcompletion_v2`，官方已标记弃用；新配置优先使用上面的兼容接口。 |
| Token 估算 | `POST /v1/responses/input_tokens`，不生成回复。 |
| 服务端搜索 | Responses 请求中声明 `web_search`，由 MiniMax 模型搜索并回答。 |
| 独立搜索、视觉理解 | `POST /v1/coding_plan/search`、`POST /v1/coding_plan/vlm`，与官方 M Plan MCP 的接口一致。 |
| 语音识别 | `POST /v1/speech_to_text`，支持纯文本、带说话人和时间戳的 JSON、SRT 和 WebVTT。 |
| 同步语音合成 | `POST /v1/t2a_v2`，提供 URL 或 hex 音频输出预置。 |
| 长文本语音 | `POST /v1/t2a_async_v2`，使用 `GET /v1/query/t2a_async_query_v2` 查询。 |
| 音色复刻、设计、查询、删除 | `/v1/voice_clone`、`/v1/voice_design`、`/v1/get_voice`、`/v1/delete_voice`。删除会改变远端数据。 |
| 图像生成 | `POST /v1/image_generation`，支持文字描述和参考图，提供 URL 和 Base64 输出预置。 |
| H3 视频、提示词增强、再生成 | `POST /v2/video_generation`、`/v2/h3_context_ir`、`/v2/video_regeneration`，共用查询接口。 |
| H3 查询、列表、取消/删除 | `GET /v2/query/video_generation/{task_id}`、`GET /v2/query/video_generation`、`DELETE /v2/video_generation/{task_id}`。 |
| Hailuo 兼容视频 | `POST /v1/video_generation`、`GET /v1/query/video_generation`。 |
| 官方视频模板 | `POST /v1/video_template_generation`、`GET /v1/query/video_template_generation`；从官方模板表选择 ID 和输入字段。 |
| 文件管理 | `/v1/files/upload`、`/v1/files/list`、`/v1/files/retrieve`、`/v1/files/retrieve_content`、`/v1/files/delete`。 |
| 音乐历史兼容 | `/v1/music_generation`、`/v1/music_cover_preprocess`、`/v1/lyrics_generation`；仅保留给仍有历史付费权限的账号。 |

复杂操作使用 `payload` JSON 参数，默认内容只是正确请求形状的示例。涉及既有资源的操作必须替换文件 ID、
音色 ID、源任务 ID 或模板 ID；不要把示例数字 `0` 或说明文字当作真实资源。查询参数中的任务/文件 ID 保持原值，
不要无条件转成 JavaScript 数字。

## 订阅和模型限制

当前 M Plan 的 Go、Explore、Build 包含文本、图像、音频、搜索和多模态理解；Explore、Build 另包含 H3 视频。
ASR 官方指南也明确支持 M Plan。Key 前缀不能确定用户的档位、旧 Token Plan 身份或剩余额度，实际权限以账号查询和
接口结果为准。订阅 Key 与按量 Key 相互独立；订阅额度耗尽后可消耗已有积分，不会自动扣按量账户余额。

音乐付费接口从 2026 年 8 月 20 日起不再面向新用户，历史付费用户可继续使用现有服务；免费音乐模型已停止。
因此音乐操作明确标注历史兼容，不应宣传为新订阅用户已开通。M2.5/M2.7 也已停止向新用户开放，旧订阅名称路由到
M3.1 Flash；预置不以这些模型或已下线的 M2-her 作为默认值。

“全部接入”指提供已核对的 HTTP 配置入口，不代表替用户购买权限或逐一执行所有生成、删除操作。
生成图片、视频、语音、复刻音色等调用会消耗 MiniMax 用量。默认聊天仍可使用本机 Codex，MiniMax 能力按任务调用。

## ASR、OCR 和实时语音

ASR 上游单次最多 500 秒、50 MB，超限会报错，不会截断。支持 wav、aiff、flac、alac/m4a、mp3、aac、opus、ogg，
不接受无容器的裸 PCM，也不接受音频流式输入。官方 `stream=true` 指返回 SSE，不是实时上传音频。
本预置使用非流式 HTTP；说话人分离和字幕导出使用非流式格式。

官方目录中没有独立 OCR API。MiniMax 的“图像理解与文字提取”通过视觉模型完成，不承诺专用 OCR 的坐标、置信度或
版面结构。需要专用 OCR 协议时，使用通用 JSON 模板按实际服务文档配置。

MiniMax 另有 `/ws/v1/t2a_v2` 和 `/ws/v1/t2a_v2_bidi` 两套 WebSocket 会话协议。本页 HTTP 预置不把这些实时传输宣称为
已接入；同步和异步 HTTP 语音合成仍可使用。不得把 WebSocket 地址当作普通 HTTP POST 配置。

## 任务与文件结果

**服务器设置 → API 端点 → 任务与产物** 显示本机最近 50 条运行记录，包括用户试运行和助手发起的操作。
点击某个端点旁的 **任务与产物** 可按端点筛选，**全部端点** 返回总览。记录会跨页面关闭和应用重启保留。
每条记录显示操作、状态、文件数量和保存的时间；较早记录没有时间戳时会明确显示“旧记录未保存时间”，不会推测日期。

**查看结果** 只读取本机保存的结果，不联系服务商，也不会再次生成。任务仍在处理时，用户明确点击
**刷新任务结果** 才查询既有任务。结果未知的请求继续显示核对提示，不会自动重发。详情页没有“再次生成”按钮。

删除端点配置后，历史仍可在全部端点中找到，并标为 **已删除的端点**。已经缓存在本机的产物仍可保存；尚未下载的
远端 URL 必须由仍存在、已启用且与任务版本一致的配置访问。助手工具仍只能查询或下载自己的任务结果，本机 UI
提供给主人查看本机历史的独立入口，不向助手开放其他助手的记录。

H3 成功结果使用 `task.content.url`，提示词增强使用 `task.content.prompt`。旧视频使用首字母大写的状态，例如
`Success`，不能与 H3 的 `succeeded` 混用。长文本语音和旧视频成功后返回 `file_id`，继续调用“检索并下载文件”。
文件名可由 `fileName` 参数指定，默认 `output.bin`，建议填写真实扩展名。

主模板仅允许 MiniMax 与 Hailuo 官方域名后缀下载产物。如果当前账号返回其他 CDN，应先核对该准确主机的归属再编辑
允许列表，不使用 `*` 放行所有主机。产物下载不携带渠道密钥。TTS 临时 URL 当前有效期为 24 小时；过期的任务产物可
先重新查询，再下载。

旧接口可能在 HTTP 200 中返回非零 `base_resp.status_code`，这仍是失败。模板同时声明业务错误提取规则。
修改 `output_format` 或 `response_format` 时，也需要修改相应结果路径、编码和 MIME 类型，避免把 hex 音频当作 URL，
或把字幕文本当作 JSON。

官方文件接口有少量文档展示不一致：文件检索页面示例有 `file.download_url`，其 schema 未列出该字段；文件删除的
header 示例包含拼写错误，模板采用该接口 requestBody 明确声明的 JSON。实际账号调用仍需单独验证。

这项任务与产物入口参考了 Grok Bot 的[可检查结果与 Library](https://docs.x.ai/grok-bot/files-and-results)及
[工作、待处理、未读状态](https://docs.x.ai/grok-bot/settings-and-notifications)的公开交互方式。
本轮实现范围为本机 API 任务的恢复和产物查找；OpenBot 原有的助手记忆、计划、文件页和对话继续复用。

## 官方参考

- [完整文档和 OpenAPI / AsyncAPI 索引](https://platform.minimax.cn/docs/llms.txt)
- [接口概览](https://platform.minimax.cn/docs/api-reference/api-overview)
- [模型列表和下线安排](https://platform.minimax.cn/docs/faq/models)
- [M Plan 常见问题](https://platform.minimax.cn/docs/m-plan/faq)
- [ASR 使用说明](https://platform.minimax.cn/docs/guides/speech-to-text)
- [同步语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)
- [H3 创建接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)
- [H3 查询接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)
- [官方视频模板表](https://platform.minimax.cn/docs/faq/video-agent-templates)
- [官方搜索与视觉 MCP 源码](https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP/blob/main/minimax_mcp/server.py)
- [MiniMax CLI 使用说明](https://platform.minimax.cn/docs/m-plan/minimax-cli)
