import {
  type ApiChannelDefinition,
  type ApiChannelOperation,
  type ApiChannelRun,
  type ApiChannelRunSummary,
  type ApiChannelSummary,
  isApiChannelDefinition,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { currentText } from "@openbot/ui/text";

const example: ApiChannelDefinition = {
  name: "API 草稿示例",
  description: "可编辑的 HTTP 接口示例，不访问外部服务。",
  baseUrl: "https://api.example.test",
  auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
  headers: [],
  artifactHosts: [],
  operations: [
    {
      id: "recognize",
      name: "文字识别示例",
      description: "从图片地址提取文字的配置示例。",
      method: "POST",
      path: "/ocr",
      bodyType: "json",
      body: JSON.stringify({ image_url: "{{image_url}}" }),
      query: [],
      parameters: [
        {
          name: "image_url",
          type: "string",
          required: true,
          description: "图片地址。",
          defaultJson: '"https://example.test/image.png"',
        },
      ],
      readOnly: false,
      response: {
        format: "json",
        resultPath: "text",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
  ],
};

function previewArtifacts(operation: ApiChannelOperation): ApiChannelRun["artifacts"] {
  const artifacts = operation.response.artifacts.map((rule) => ({
    id: crypto.randomUUID(),
    fileName: rule.fileName,
    mimeType: rule.mimeType,
  }));
  if (!artifacts.length && operation.response.format === "binary")
    artifacts.push({
      id: crypto.randomUUID(),
      fileName: operation.response.fileName || "preview-output.bin",
      mimeType: operation.response.mimeType || "application/octet-stream",
    });
  return artifacts;
}

/** An editable, in-memory preview. Only credential presence is remembered, never its value. */
export function createMockApiChannels(): OpenBotDesktopApi["apiChannels"] {
  let channels: ApiChannelSummary[] = [
    {
      id: "preview-api-draft",
      definition: structuredClone(example),
      enabled: false,
      source: "agent",
      credentialStatus: "missing",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
  ];
  const runs = new Map<string, ApiChannelRun>();
  const runTimes = new Map<string, { createdAt: string; updatedAt: string }>();
  const definition = (text: string): ApiChannelDefinition => {
    try {
      if (text.length > 512_000) throw new Error();
      const value = JSON.parse(text);
      if (!isApiChannelDefinition(value)) throw new Error();
      for (const operation of value.operations) {
        if (operation.bodyType !== "none") JSON.parse(operation.body);
        for (const parameter of operation.parameters) if (parameter.defaultJson) JSON.parse(parameter.defaultJson);
      }
      return value;
    } catch {
      throw new Error(sourceText("error.apiChannel.invalid"));
    }
  };
  const find = (id: string) => {
    const channel = channels.find((item) => item.id === id);
    if (!channel) throw new Error(sourceText("error.apiChannel.unavailable"));
    return channel;
  };
  const requireCredential = (channel: ApiChannelSummary) => {
    if (channel.definition.auth.type !== "none" && channel.credentialStatus !== "saved")
      throw new Error(sourceText("error.apiChannel.credential"));
  };
  return {
    list: async () => structuredClone(channels),
    listRuns: async ({ channelId }) => {
      const history: ApiChannelRunSummary[] = [...runs.values()]
        .filter((run) => channelId === undefined || run.channelId === channelId)
        .map((run) => {
          const channel = channels.find((item) => item.id === run.channelId);
          const times = runTimes.get(run.id);
          return {
            id: run.id,
            channelId: run.channelId,
            channelName: channel?.definition.name ?? null,
            operationId: run.operationId,
            operationName:
              channel?.definition.operations.find((item) => item.id === run.operationId)?.name ?? run.operationId,
            status: run.status,
            createdAt: times?.createdAt ?? null,
            updatedAt: times?.updatedAt ?? null,
            artifactCount: run.artifacts.length,
          };
        })
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
        .slice(0, 50);
      return structuredClone(history);
    },
    getRun: async ({ id }) => {
      const run = runs.get(id);
      if (!run) throw new Error(sourceText("error.apiChannel.run"));
      return structuredClone(run);
    },
    templates: async () => [
      {
        id: "preview-generic",
        name: "自定义 HTTP 示例",
        description: "预览用通用接口配置，不会发送请求。",
        docsUrl: "https://example.com",
        definition: structuredClone(example),
      },
    ],
    validate: async ({ definitionJson }) => structuredClone(definition(definitionJson)),
    save: async (input) => {
      const next = definition(input.definitionJson);
      const existing = input.id ? find(input.id) : null;
      const supplied = Boolean(input.apiKey?.trim());
      if (supplied && input.clearApiKey) throw new Error(sourceText("error.apiChannel.invalid"));
      if (
        existing?.credentialStatus === "saved" &&
        new URL(existing.definition.baseUrl).origin !== new URL(next.baseUrl).origin &&
        !supplied &&
        !input.clearApiKey
      )
        throw new Error(sourceText("error.apiChannel.origin"));
      const credentialStatus = supplied
        ? "saved"
        : input.clearApiKey
          ? next.auth.type === "none"
            ? "not-required"
            : "missing"
          : (existing?.credentialStatus ?? (next.auth.type === "none" ? "not-required" : "missing"));
      const channel: ApiChannelSummary = {
        id: existing?.id ?? crypto.randomUUID(),
        definition: next,
        enabled: input.enabled,
        source: "user",
        credentialStatus,
        updatedAt: new Date().toISOString(),
      };
      if (channel.enabled) requireCredential(channel);
      channels = [...channels.filter((item) => item.id !== channel.id), channel];
      return structuredClone(channel);
    },
    setEnabled: async ({ id, enabled }) => {
      const channel = find(id);
      if (enabled) requireCredential(channel);
      const updated = { ...channel, enabled, updatedAt: new Date().toISOString() };
      channels = channels.map((item) => (item.id === id ? updated : item));
      return structuredClone(updated);
    },
    delete: async ({ id }) => {
      channels = channels.filter((channel) => channel.id !== id);
    },
    invoke: async ({ channelId, operationId, valuesJson }) => {
      const channel = find(channelId);
      const operation = channel.definition.operations.find((item) => item.id === operationId);
      if (!channel.enabled || !operation) throw new Error(sourceText("error.apiChannel.unavailable"));
      if (operation.parameters.some((parameter) => parameter.type === "file"))
        throw new Error(sourceText("error.apiChannel.file"));
      try {
        if (valuesJson.length > 512_000 || !isDynamicRecord(JSON.parse(valuesJson))) throw new Error();
      } catch {
        throw new Error(sourceText("error.apiChannel.parameters"));
      }
      const result: ApiChannelRun = {
        id: crypto.randomUUID(),
        channelId,
        operationId,
        status: operation.job ? "pending" : "completed",
        output: { preview: true, message: currentText().t("apiChannels.preview.result") },
        artifacts: operation.job ? [] : previewArtifacts(operation),
        message: null,
      };
      runs.set(result.id, result);
      const now = new Date().toISOString();
      runTimes.set(result.id, { createdAt: now, updatedAt: now });
      return structuredClone(result);
    },
    readRun: async ({ id }) => {
      const run = runs.get(id);
      if (!run) throw new Error(sourceText("error.apiChannel.run"));
      if (run.status === "unknown") return structuredClone(run);
      const result: ApiChannelRun = { ...run, status: "completed" };
      runs.set(id, result);
      const now = new Date().toISOString();
      runTimes.set(id, { createdAt: runTimes.get(id)?.createdAt ?? now, updatedAt: now });
      return structuredClone(result);
    },
    saveArtifact: async ({ id }) => {
      if (![...runs.values()].some((run) => run.artifacts.some((artifact) => artifact.id === id)))
        throw new Error(sourceText("error.apiChannel.artifact"));
      // The preview never writes a file or opens an operating-system dialog.
    },
  };
}
