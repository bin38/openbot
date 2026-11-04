import type {
  ApiChannelArtifactRule,
  ApiChannelDefinition,
  ApiChannelOperation,
  ApiChannelParameter,
  ApiChannelTemplate,
  ApiChannelValue,
} from "@openbot/contracts/ipc";

// Editable configuration data, not executable adapters. Nothing here contains a credential,
// enables a channel, or makes a request. The executor validates each saved copy at its boundary.
const MINIMAX_ORIGIN = "https://api.minimax.cn";
const MINIMAX_DOCS = "https://platform.minimax.cn/docs";
const MINIMAX_ARTIFACT_HOSTS = ["*.minimax.chat", "*.hailuoai.com", "*.minimax.cn"];

function parameter(
  name: string,
  type: ApiChannelParameter["type"],
  description: string,
  value?: ApiChannelValue,
): ApiChannelParameter {
  return {
    name,
    type,
    description,
    required: value === undefined,
    defaultJson: value === undefined ? "" : JSON.stringify(value),
  };
}

function response(overrides: Partial<ApiChannelOperation["response"]> = {}): ApiChannelOperation["response"] {
  return {
    format: "json",
    resultPath: "",
    errorPath: "base_resp.status_code",
    okValues: ["0"],
    fileName: "",
    mimeType: "",
    artifacts: [],
    statusPath: "",
    successValues: [],
    failureValues: [],
    ...overrides,
  };
}

function artifact(
  path: string,
  encoding: ApiChannelArtifactRule["encoding"],
  fileName: string,
  mimeType: string,
): ApiChannelArtifactRule {
  return { path, encoding, fileName, mimeType };
}

interface OperationInput {
  id: string;
  name: string;
  description: string;
  path: string;
  method?: ApiChannelOperation["method"];
  bodyType?: ApiChannelOperation["bodyType"];
  body?: string;
  parameters?: ApiChannelParameter[];
  query?: ApiChannelOperation["query"];
  readOnly?: boolean;
  result?: Partial<ApiChannelOperation["response"]>;
  job?: ApiChannelOperation["job"];
}

function operation(input: OperationInput): ApiChannelOperation {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    path: input.path,
    method: input.method ?? "GET",
    bodyType: input.bodyType ?? "none",
    body: input.body ?? "",
    parameters: input.parameters ?? [],
    query: input.query ?? [],
    readOnly: input.readOnly ?? true,
    response: response(input.result),
    job: input.job ?? null,
  };
}

function jsonOperation(
  input: Omit<OperationInput, "body" | "bodyType" | "parameters"> & { example: ApiChannelValue },
): ApiChannelOperation {
  return operation({
    ...input,
    method: input.method ?? "POST",
    readOnly: input.readOnly ?? false,
    bodyType: "json",
    body: JSON.stringify("{{payload}}"),
    parameters: [
      parameter(
        "payload",
        "json",
        "完整 JSON 请求体；可按官方文档编辑高级参数。输出格式须与本操作的结果提取规则一致。",
        input.example,
      ),
    ],
  });
}

function taskParameter(): ApiChannelParameter {
  return parameter("task_id", "string", "创建操作返回的任务 ID；保持原始字符串，不转换或截断。");
}

function fileParameters(): ApiChannelParameter[] {
  return [
    parameter("file_id", "string", "MiniMax 返回的文件 ID。"),
    parameter("fileName", "string", "保存到对话附件的文件名，包含正确扩展名。", "output.bin"),
  ];
}

const videoJob = { idPath: "task_id", pollOperationId: "video_query", pollParameter: "task_id" };
const legacyVideoJob = { idPath: "task_id", pollOperationId: "hailuo_query", pollParameter: "task_id" };

function minimaxOperations(): ApiChannelOperation[] {
  return [
    operation({
      id: "models",
      name: "获取模型列表",
      description: "只读取官方模型目录，不执行模型对话；目录不等于当前套餐的全部授权。",
      path: "/v1/models",
    }),
    operation({
      id: "model_detail",
      name: "获取模型详情",
      description: "读取指定模型的官方元数据。",
      path: "/v1/models/{{model_id}}",
      parameters: [parameter("model_id", "string", "模型 ID。", "MiniMax-M3.1-Flash")],
    }),
    jsonOperation({
      id: "chat",
      name: "文本与多模态对话",
      path: "/v1/chat/completions",
      description:
        "调用 MiniMax 模型，不改变 OpenBot 的本机 Codex 默认模型。messages 可按官方格式包含图片、视频和工具调用；将消耗 MiniMax 用量。",
      example: {
        model: "MiniMax-M3.1-Flash",
        messages: [{ role: "user", content: "你好，请用中文回答。" }],
        stream: false,
      },
    }),
    jsonOperation({
      id: "responses",
      name: "Responses 对话与多模态输入",
      path: "/v1/responses",
      description: "OpenAI Responses 兼容入口。可编辑 input、reasoning、tools 等字段；本模板使用非流式结果。",
      example: { model: "MiniMax-M3.1-Flash", input: "请用中文概括输入内容。", stream: false },
    }),
    jsonOperation({
      id: "legacy_chat",
      name: "原生文本对话（已弃用兼容入口）",
      path: "/v1/text/chatcompletion_v2",
      description:
        "保留官方标记 deprecated 的旧文本入口。新配置优先使用 Chat Completions 或 Responses；不使用已下线的 M2-her 作为默认模型。",
      example: {
        model: "MiniMax-M3.1-Flash",
        messages: [{ role: "user", content: "你好，请用中文回答。" }],
        stream: false,
      },
    }),
    jsonOperation({
      id: "input_tokens",
      name: "估算输入 Token",
      path: "/v1/responses/input_tokens",
      readOnly: true,
      description: "估算输入 Token，不生成模型回复。",
      example: { model: "MiniMax-M3.1-Flash", input: "需要估算的文本" },
    }),
    jsonOperation({
      id: "server_search",
      name: "模型联网搜索",
      path: "/v1/responses",
      description: "MiniMax 服务端执行 web_search 并生成回答；这是模型调用，会消耗 MiniMax 用量。",
      example: {
        model: "MiniMax-M3.1-Flash",
        input: "请搜索并总结最新的 MiniMax 官方更新。",
        tools: [{ type: "web_search" }],
        stream: false,
      },
    }),
    jsonOperation({
      id: "web_search",
      name: "独立网络搜索",
      path: "/v1/coding_plan/search",
      readOnly: true,
      description: "官方 M Plan MCP 使用的搜索 API，返回网页结果及相关搜索词；受套餐额度和权限限制。",
      example: { q: "MiniMax 官方文档" },
    }),
    jsonOperation({
      id: "vision",
      name: "图像理解与文字提取",
      path: "/v1/coding_plan/vlm",
      description:
        "通过视觉模型理解 JPEG、PNG 或 WebP，也可提示提取文字。这不是提供坐标和置信度保证的独立 OCR 接口。image_url 使用图片 URL 或 data URI。",
      example: {
        prompt: "按阅读顺序提取图片中的文字；无法辨认的部分明确标注。",
        image_url: "https://example.com/input.png",
      },
      result: { resultPath: "content" },
    }),
    operation({
      id: "vision_file",
      name: "工作区图片文字提取",
      method: "POST",
      path: "/v1/coding_plan/vlm",
      bodyType: "json",
      readOnly: false,
      description:
        "读取当前助手工作区中的 JPEG、PNG 或 WebP，通过 data URI 发送给 MiniMax 视觉模型。只上传所选文件，不把本机路径发送给服务；这是视觉文字提取，不是专用 OCR。",
      body: JSON.stringify({ prompt: "{{prompt}}", image_url: "{{image}}" }),
      parameters: [
        parameter(
          "prompt",
          "string",
          "希望模型从图片中识别或提取的内容。",
          "按阅读顺序提取图片中的文字；无法辨认的部分明确标注。",
        ),
        { ...parameter("image", "file", "工作区中的待识别图片。"), fileEncoding: "data-url" },
      ],
      result: { resultPath: "content" },
    }),
    operation({
      id: "asr",
      name: "语音识别与说话人分离",
      method: "POST",
      path: "/v1/speech_to_text",
      bodyType: "multipart",
      readOnly: false,
      description:
        "asr-1.0 文件识别。上游单次最多 500 秒、50 MB；verbose_json 返回说话人和时间戳。文件参数从当前工作区安全上传，不读取任意主机路径。",
      body: JSON.stringify({
        model: "asr-1.0",
        file: "{{file}}",
        response_format: "verbose_json",
        timestamp_level: "{{timestamp_level}}",
        stream: false,
      }),
      parameters: [
        parameter("file", "file", "待识别音频文件。"),
        parameter("timestamp_level", "string", "时间戳粒度：空字符串、sentence 或 word。", "sentence"),
      ],
      result: { errorPath: "" },
    }),
    operation({
      id: "asr_subtitles",
      name: "语音识别导出 SRT",
      method: "POST",
      path: "/v1/speech_to_text",
      bodyType: "multipart",
      readOnly: false,
      description: "将音频转为 SRT 字幕文本。上游单次最多 500 秒、50 MB；不支持音频流式输入。",
      body: JSON.stringify({ model: "asr-1.0", file: "{{file}}", response_format: "srt", stream: false }),
      parameters: [parameter("file", "file", "待生成字幕的音频文件。")],
      result: { format: "text", errorPath: "", fileName: "transcript.srt", mimeType: "application/x-subrip" },
    }),
    operation({
      id: "asr_text",
      name: "语音识别提取纯文本",
      method: "POST",
      path: "/v1/speech_to_text",
      bodyType: "multipart",
      readOnly: false,
      description: "仅提取识别文本，不启用说话人分离。上游单次最多 500 秒、50 MB。",
      body: JSON.stringify({ model: "asr-1.0", file: "{{file}}", response_format: "json", stream: false }),
      parameters: [parameter("file", "file", "待识别的音频文件。")],
      result: { resultPath: "text", errorPath: "" },
    }),
    operation({
      id: "asr_vtt",
      name: "语音识别导出 WebVTT",
      method: "POST",
      path: "/v1/speech_to_text",
      bodyType: "multipart",
      readOnly: false,
      description: "将音频识别为 WebVTT 字幕文本。上游单次最多 500 秒、50 MB。",
      body: JSON.stringify({ model: "asr-1.0", file: "{{file}}", response_format: "vtt", stream: false }),
      parameters: [parameter("file", "file", "待生成字幕的音频文件。")],
      result: { format: "text", errorPath: "", fileName: "transcript.vtt", mimeType: "text/vtt" },
    }),
    jsonOperation({
      id: "tts",
      name: "同步语音合成",
      path: "/v1/t2a_v2",
      description:
        "使用 speech-2.8-hd 合成语音。可改用 speech-2.8-turbo；先查询音色列表选择 voice_id。此操作固定预期 URL 音频结果。",
      example: {
        model: "speech-2.8-hd",
        text: "你好，欢迎使用语音合成。",
        voice_setting: { voice_id: "Chinese (Mandarin)_Lyrical_Voice", speed: 1, vol: 1, pitch: 0 },
        audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
        stream: false,
        output_format: "url",
      },
      result: {
        artifacts: [
          artifact("data.audio", "url", "speech.mp3", "audio/mpeg"),
          artifact("data.subtitle_file", "url", "speech-subtitles.json", "application/json"),
        ],
      },
    }),
    jsonOperation({
      id: "tts_hex",
      name: "同步语音合成（十六进制音频）",
      path: "/v1/t2a_v2",
      description: "将返回的 hex 音频解码为附件，适用于不使用临时下载链接的短文本；长文本优先使用异步合成。",
      example: {
        model: "speech-2.8-turbo",
        text: "你好。",
        voice_setting: { voice_id: "Chinese (Mandarin)_Lyrical_Voice" },
        audio_setting: { format: "mp3" },
        stream: false,
        output_format: "hex",
      },
      result: { artifacts: [artifact("data.audio", "hex", "speech.mp3", "audio/mpeg")] },
    }),
    jsonOperation({
      id: "tts_async",
      name: "创建长文本语音任务",
      path: "/v1/t2a_async_v2",
      description: "创建异步语音任务。可用 text_file_id 替代 text；完成后用 file_id 调用“检索并下载文件”。",
      example: {
        model: "speech-2.8-hd",
        text: "需要合成的长文本。",
        voice_setting: { voice_id: "Chinese (Mandarin)_Lyrical_Voice" },
        audio_setting: { format: "mp3" },
      },
      job: { idPath: "task_id", pollOperationId: "tts_async_query", pollParameter: "task_id" },
    }),
    operation({
      id: "tts_async_query",
      name: "查询长文本语音任务",
      description: "成功后返回 file_id；继续调用文件检索操作下载音频或压缩包。",
      path: "/v1/query/t2a_async_query_v2",
      parameters: [taskParameter()],
      query: [{ name: "task_id", value: "{{task_id}}" }],
      result: { statusPath: "status", successValues: ["success"], failureValues: ["failed", "expired"] },
    }),
    jsonOperation({
      id: "voice_clone",
      name: "创建复刻音色",
      path: "/v1/voice_clone",
      description:
        "先以 voice_clone 用途上传本人或已获授权的音频，再提交文件 ID 和自定义 voice_id。平台要求身份认证。可按文档增加示例音频和试听文本。",
      example: { file_id: 0, voice_id: "my_voice_001" },
      result: { artifacts: [artifact("demo_audio", "url", "voice-clone-preview.mp3", "audio/mpeg")] },
    }),
    jsonOperation({
      id: "voice_design",
      name: "根据描述设计音色",
      path: "/v1/voice_design",
      description: "返回新音色 ID 和 hex 格式的试听音频，后续合成可使用该 voice_id。",
      example: { prompt: "自然、清晰、语速平稳的中文讲解声音。", preview_text: "你好，这是新音色的试听内容。" },
      result: { artifacts: [artifact("trial_audio", "hex", "voice-design-preview.mp3", "audio/mpeg")] },
    }),
    jsonOperation({
      id: "voices",
      name: "查询可用音色",
      description: "查询系统、复刻和设计音色。voice_type 可选 system、voice_cloning、voice_generation 或 all。",
      path: "/v1/get_voice",
      readOnly: true,
      example: { voice_type: "all" },
    }),
    jsonOperation({
      id: "voice_delete",
      name: "删除自定义音色",
      description: "删除指定复刻或设计音色。此操作会改变远端数据，仅在明确需要删除时调用。",
      path: "/v1/delete_voice",
      example: { voice_type: "voice_cloning", voice_id: "需要删除的音色ID" },
    }),
    jsonOperation({
      id: "image",
      name: "图片生成与参考图生成",
      path: "/v1/image_generation",
      description:
        "image-01 支持文生图和人物参考图。图生图可增加 subject_reference:[{type:'character',image_file:'图片URL或data URI'}]。image-01-live 另支持画风设置。",
      example: {
        model: "image-01",
        prompt: "一张简洁的中文阅读角插画。",
        aspect_ratio: "16:9",
        response_format: "url",
        n: 1,
      },
      result: { artifacts: [artifact("data.image_urls", "url", "image.png", "image/png")] },
    }),
    jsonOperation({
      id: "image_base64",
      name: "图片生成（Base64）",
      path: "/v1/image_generation",
      description: "将返回的图片 Base64 解码为附件；批量生成时每张图片保存为单独附件。",
      example: { model: "image-01", prompt: "一张简洁的中文阅读角插画。", response_format: "base64", n: 1 },
      result: { artifacts: [artifact("data.image_base64", "base64", "image.png", "image/png")] },
    }),
    jsonOperation({
      id: "video",
      name: "创建 H3 多模态视频",
      path: "/v2/video_generation",
      description:
        "可用 MiniMax-H3、H3-Highspeed、H3-Lite 或 H3-Max。content 可包含首尾帧、参考图/视频/音频。H3 视频需要相应套餐或按量权限；提交后使用任务查询。",
      example: {
        model: "MiniMax-H3",
        content: [{ type: "text", text: "镜头缓慢推近一座安静的图书馆。" }],
        resolution: "768P",
        duration: 5,
        ratio: "16:9",
      },
      job: videoJob,
    }),
    jsonOperation({
      id: "video_context",
      name: "创建 H3 提示词增强任务",
      path: "/v2/h3_context_ir",
      description:
        "MiniMax-H3 专用；根据多模态上下文生成增强提示词。共用视频任务查询，成功结果为 task.content.prompt。",
      example: {
        model: "MiniMax-H3",
        content: [{ type: "text", text: "镜头缓慢推近一座安静的图书馆。" }],
        duration: 5,
        ratio: "16:9",
      },
      job: videoJob,
    }),
    jsonOperation({
      id: "video_regenerate",
      name: "创建 H3 2K 再生成任务",
      path: "/v2/video_regeneration",
      description: "从符合条件的 MiniMax-H3 768P 源任务生成 2K 视频。source_task_id 必须替换为已有源任务 ID。",
      example: { model: "MiniMax-H3", source_task_id: "已有的H3源任务ID", resolution: "2K" },
      job: videoJob,
    }),
    operation({
      id: "video_query",
      name: "查询 H3 任务并下载结果",
      path: "/v2/query/video_generation/{{task_id}}",
      parameters: [taskParameter()],
      description:
        "视频成功时下载 task.content.url；提示词增强成功时返回 task.content.prompt。临时 URL 过期后可重新查询。",
      result: {
        errorPath: "",
        statusPath: "task.status",
        successValues: ["succeeded"],
        failureValues: ["failed", "cancelled"],
        artifacts: [artifact("task.content.url", "url", "video.mp4", "video/mp4")],
      },
    }),
    operation({
      id: "video_list",
      name: "查询 H3 任务列表",
      path: "/v2/query/video_generation",
      description:
        "分页读取最近 7 天的任务。需要高级过滤时可编辑查询参数，官方支持状态、模型、任务类型和任务 ID 过滤。",
      parameters: [
        parameter("page", "number", "页码，从 1 开始。", 1),
        parameter("page_size", "number", "每页数量。", 20),
      ],
      query: [
        { name: "page_num", value: "{{page}}" },
        { name: "page_size", value: "{{page_size}}" },
      ],
      result: { errorPath: "" },
    }),
    operation({
      id: "video_delete",
      name: "取消或删除 H3 任务",
      method: "DELETE",
      path: "/v2/video_generation/{{task_id}}",
      parameters: [taskParameter()],
      readOnly: false,
      description: "取消排队中的任务，或删除成功/失败任务记录；仅在明确要求时使用。",
      result: { errorPath: "" },
    }),
    jsonOperation({
      id: "hailuo_video",
      name: "创建 Hailuo 视频（兼容）",
      path: "/v1/video_generation",
      description:
        "旧版视频 HTTP 接口。支持 Hailuo-2.3、Hailuo-02 文生/图生；Hailuo-2.3-Fast 为图生。图生增加 first_frame_image；Hailuo-02 首尾帧增加 last_frame_image。",
      example: {
        model: "MiniMax-Hailuo-2.3",
        prompt: "镜头缓慢推近一座安静的图书馆。",
        duration: 6,
        resolution: "768P",
      },
      job: legacyVideoJob,
    }),
    operation({
      id: "hailuo_query",
      name: "查询 Hailuo 视频任务",
      path: "/v1/query/video_generation",
      parameters: [taskParameter()],
      query: [{ name: "task_id", value: "{{task_id}}" }],
      description: "旧视频任务状态采用大写开头。成功后用 file_id 调用“检索并下载文件”。",
      result: { statusPath: "status", successValues: ["Success"], failureValues: ["Fail"] },
    }),
    jsonOperation({
      id: "video_template",
      name: "创建官方视频模板任务（兼容）",
      path: "/v1/video_template_generation",
      description: "按官方视频模板表填写 template_id、text_inputs、media_inputs。模板及其参数依平台当前支持情况而定。",
      example: { template_id: "从官方模板表选择ID", text_inputs: [], media_inputs: [] },
      job: { idPath: "task_id", pollOperationId: "video_template_query", pollParameter: "task_id" },
    }),
    operation({
      id: "video_template_query",
      name: "查询官方视频模板任务",
      path: "/v1/query/video_template_generation",
      parameters: [taskParameter()],
      query: [{ name: "task_id", value: "{{task_id}}" }],
      description: "模板任务成功后下载 video_url。",
      result: {
        statusPath: "status",
        successValues: ["Success"],
        failureValues: ["Fail"],
        artifacts: [artifact("video_url", "url", "template-video.mp4", "video/mp4")],
      },
    }),
    operation({
      id: "file_upload",
      name: "上传 MiniMax 输入文件",
      method: "POST",
      path: "/v1/files/upload",
      bodyType: "multipart",
      readOnly: false,
      description:
        "purpose 可为 voice_clone、prompt_audio、t2a_async_input、video_understanding 或 video_generation_input。上传受各能力的上游格式和大小限制。",
      body: JSON.stringify({ purpose: "{{purpose}}", file: "{{file}}" }),
      parameters: [
        parameter("purpose", "string", "文件用途。", "voice_clone"),
        parameter("file", "file", "待上传的工作区文件。"),
      ],
    }),
    operation({
      id: "file_list",
      name: "列出 MiniMax 文件",
      description: "读取当前账号的文件元数据；需要按用途过滤时可增加 purpose 查询参数。",
      path: "/v1/files/list",
    }),
    operation({
      id: "file_retrieve",
      name: "检索并下载 MiniMax 文件",
      path: "/v1/files/retrieve",
      parameters: fileParameters(),
      query: [{ name: "file_id", value: "{{file_id}}" }],
      description: "以文件 ID 获取元数据和临时下载 URL，并保存为当前对话的附件。下载到 CDN 时不会转发渠道密钥。",
      result: { artifacts: [artifact("file.download_url", "url", "{{fileName}}", "application/octet-stream")] },
    }),
    operation({
      id: "file_download",
      name: "直接下载 MiniMax 文件内容",
      path: "/v1/files/retrieve_content",
      parameters: fileParameters(),
      query: [{ name: "file_id", value: "{{file_id}}" }],
      description: "直接下载模型生成文件的内容；通常优先使用“检索并下载文件”以保留文件元数据。",
      result: { format: "binary", fileName: "{{fileName}}", mimeType: "application/octet-stream" },
    }),
    jsonOperation({
      id: "file_delete",
      name: "删除 MiniMax 文件",
      path: "/v1/files/delete",
      description: "删除远端文件；必须填写对应 file_id 和 purpose，仅在明确要求时调用。",
      example: { file_id: 0, purpose: "voice_clone" },
    }),
    jsonOperation({
      id: "music",
      name: "音乐生成与翻唱（仅历史付费用户）",
      path: "/v1/music_generation",
      description:
        "音乐付费 API 自 2026-08-20 起不再面向新用户，M Plan 新订阅不保证可用。仅已具备历史付费权限时使用；不提供已停止的免费模型。",
      example: {
        model: "music-3.0",
        prompt: "温暖的中文民谣，轻柔木吉他。",
        lyrics: "[Verse]\n清晨的光落在窗边\n新的故事从今天开始",
        output_format: "url",
        stream: false,
        audio_setting: { format: "mp3" },
      },
      result: { artifacts: [artifact("data.audio", "url", "music.mp3", "audio/mpeg")] },
    }),
    jsonOperation({
      id: "music_preprocess",
      name: "翻唱前处理（仅历史付费用户）",
      path: "/v1/music_cover_preprocess",
      description: "为两步翻唱提取 cover_feature_id 和歌词，仅供仍具备历史音乐权限的账号使用。",
      example: { model: "music-cover", audio_url: "https://example.com/reference.mp3" },
    }),
    jsonOperation({
      id: "lyrics",
      name: "歌词生成（仅历史付费用户）",
      path: "/v1/lyrics_generation",
      description: "历史音乐 API；mode 可为 write_full_song 或 edit。新订阅不保证此能力可用。",
      example: { mode: "write_full_song", prompt: "写一首关于清晨与新开始的中文歌曲歌词。" },
    }),
  ];
}

function minimaxDefinition(): ApiChannelDefinition {
  return {
    name: "MiniMax 中国区 API",
    description:
      "文本、多模态理解、搜索、ASR、语音、音色、图片、视频和文件管理 HTTP 接口；音乐操作仅作历史兼容。实际可用能力取决于账号套餐，导入不会执行任何操作。",
    baseUrl: MINIMAX_ORIGIN,
    auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
    headers: [],
    artifactHosts: MINIMAX_ARTIFACT_HOSTS,
    operations: minimaxOperations(),
  };
}

const TEMPLATES: ApiChannelTemplate[] = [
  {
    id: "minimax-cn",
    name: "MiniMax 中国区完整 HTTP 接口",
    description: "按官方当前文档配置多模态、ASR、任务查询和文件结果；订阅权限按实际套餐判定，音乐仅历史兼容。",
    docsUrl: `${MINIMAX_DOCS}/api-reference/api-overview`,
    definition: minimaxDefinition(),
  },
  {
    id: "minimax-messages",
    name: "MiniMax Messages 兼容接口",
    description: "使用 x-api-key 的独立配置。请求仍发往 MiniMax，不调用 Claude 账号，也不修改本机 Codex 默认模型。",
    docsUrl: `${MINIMAX_DOCS}/api-reference/text-anthropic-api`,
    definition: {
      name: "MiniMax Messages",
      description: "MiniMax 的 Anthropic Messages 兼容协议及 Token 估算，不是 Claude 账号渠道。",
      baseUrl: MINIMAX_ORIGIN,
      auth: { type: "header", name: "x-api-key", prefix: "" },
      headers: [{ name: "anthropic-version", value: "2023-06-01" }],
      artifactHosts: [],
      operations: [
        jsonOperation({
          id: "messages",
          name: "Messages 对话",
          description: "支持文本、多模态和工具调用。使用 MiniMax 模型和本渠道密钥。",
          path: "/anthropic/v1/messages",
          example: {
            model: "MiniMax-M3.1-Flash",
            max_tokens: 4096,
            messages: [{ role: "user", content: "你好，请用中文回答。" }],
            stream: false,
          },
          result: { errorPath: "" },
        }),
        jsonOperation({
          id: "count_tokens",
          name: "估算 Messages Token",
          description: "估算兼容 Messages 请求的输入 Token。",
          path: "/anthropic/v1/messages/count_tokens",
          readOnly: true,
          example: { model: "MiniMax-M3.1-Flash", messages: [{ role: "user", content: "需要估算的文本" }] },
          result: { errorPath: "" },
        }),
      ],
    },
  },
  {
    id: "minimax-quota",
    name: "MiniMax 订阅用量",
    description: "单独绑定官方用量查询 origin，只查询套餐，不创建生成任务。",
    docsUrl: `${MINIMAX_DOCS}/m-plan/faq`,
    definition: {
      name: "MiniMax 订阅用量",
      description: "查询订阅套餐和剩余额度。订阅 Key 与普通按量 Key 不混用；不会购买或升级套餐。",
      baseUrl: "https://www.minimax.cn",
      auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
      headers: [],
      artifactHosts: [],
      operations: [
        operation({
          id: "quota",
          name: "读取订阅用量",
          description: "官方只读用量接口。",
          path: "/v1/token_plan/remains",
        }),
      ],
    },
  },
  {
    id: "openai-asr",
    name: "通用 OpenAI 兼容 ASR",
    description: "替换为自己的转写服务地址、模型和鉴权方式；适用于 multipart 文件上传接口。",
    docsUrl: "https://platform.openai.com/docs/api-reference/audio/createTranscription",
    definition: {
      name: "自定义语音识别",
      description: "通用语音识别配置。保存前按服务商文档修改地址、模型和请求字段。",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
      headers: [],
      artifactHosts: [],
      operations: [
        operation({
          id: "transcribe",
          name: "转写音频",
          description: "上传所选工作区音频并提取 text；上游文件限制以该服务文档为准。",
          method: "POST",
          path: "/v1/audio/transcriptions",
          bodyType: "multipart",
          readOnly: false,
          body: JSON.stringify({ model: "{{model}}", file: "{{file}}", response_format: "json" }),
          parameters: [
            parameter("model", "string", "服务商支持的 ASR 模型 ID。", "whisper-1"),
            parameter("file", "file", "待转写的音频文件。"),
          ],
          result: { resultPath: "text", errorPath: "" },
        }),
      ],
    },
  },
  {
    id: "generic-ocr-json",
    name: "通用 OCR / JSON API",
    description: "空白服务商模板，用于接入特殊 OCR 或其他 JSON API；必须按目标文档修改，示例地址不提供真实服务。",
    docsUrl: "",
    definition: {
      name: "自定义 OCR API",
      description: "可编辑任意 JSON 请求结构和结果路径。此模板只展示常见形状，不宣称所有 OCR 服务使用同一协议。",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
      headers: [],
      artifactHosts: [],
      operations: [
        jsonOperation({
          id: "recognize",
          name: "识别图片文字（URL / 高级 JSON）",
          description: "按实际服务修改 path、payload 和 response.resultPath；图片 URL 只是示例输入。",
          path: "/v1/ocr",
          example: { image_url: "https://example.com/input.png" },
          result: { resultPath: "text", errorPath: "" },
        }),
        operation({
          id: "recognize_file",
          name: "识别工作区图片（Base64）",
          method: "POST",
          path: "/v1/ocr",
          bodyType: "json",
          readOnly: false,
          description:
            "安全读取工作区图片并编码为 Base64。image_base64 和 text 只是常见字段示例，必须按实际 OCR 服务修改请求字段与结果路径。",
          body: JSON.stringify({ image_base64: "{{image}}" }),
          parameters: [{ ...parameter("image", "file", "工作区中的图片文件。"), fileEncoding: "base64" }],
          result: { resultPath: "text", errorPath: "" },
        }),
      ],
    },
  },
];

/** Return an independent editable copy; the catalog cannot be changed by a caller. */
export function apiChannelTemplates(): ApiChannelTemplate[] {
  return structuredClone(TEMPLATES);
}
