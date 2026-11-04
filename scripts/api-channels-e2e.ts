// Drives the real API channel store/service against two loopback HTTP servers with an AES-GCM
// cipher. No external service, provider conversation, or user credential is used.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ApiChannelDefinition,
  ApiChannelOperation,
  ApiChannelParameter,
  ApiChannelRun,
  ApiChannelValue,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { Effect, Exit, Fiber } from "effect";
import { withApiChannelRequestCancellation } from "../src/backend/agent/api-channel-tools";
import type { GeneratedAttachmentSource } from "../src/backend/attachment-files";
import type { ApiChannelFetch } from "../src/main/api-channel-http";
import { ApiChannelService } from "../src/main/api-channel-service";
import { ApiChannelStore } from "../src/main/api-channel-store";

const logger = createOpenBotLogger("api-channels-e2e");
const output = resolve(import.meta.dirname, "../.openbot-build/api-channels-e2e/report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-api-channels-"));
const storePath = join(root, "channels.json");
const cache = join(root, "artifacts");
const secret = "fixture-channel-credential-a4bcda89";
const replacement = "fixture-channel-replacement-190fcb85";
const signedUrl = "https://files.example.test/asset?signature=fixture-signed-download";
const longText = "完整输出".repeat(12_000);
const fullItems = Array.from({ length: 300 }, (_, index) => ({ index, text: `row-${index}` }));
const cipherKey = randomBytes(32);
const cipher = {
  canPersist: () => true,
  encrypt: (value: string) => {
    const iv = randomBytes(12);
    const encrypt = createCipheriv("aes-256-gcm", cipherKey, iv);
    const ciphertext = Buffer.concat([encrypt.update(value, "utf8"), encrypt.final()]);
    return Buffer.concat([iv, encrypt.getAuthTag(), ciphertext]);
  },
  decrypt: (value: Buffer) => {
    const decrypt = createDecipheriv("aes-256-gcm", cipherKey, value.subarray(0, 12));
    decrypt.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decrypt.update(value.subarray(28)), decrypt.final()]).toString("utf8");
  },
};
interface CapturedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
const calls: CapturedRequest[] = [];
const assetCalls: CapturedRequest[] = [];
let pollCount = 0;
let redirectTargetCount = 0;
let blockedClosed = false;
let signalBlockedStarted = () => {};
let signalBlockedClosed = () => {};
const blockedStarted = new Promise<void>((done) => {
  signalBlockedStarted = done;
});
const blockedEnded = new Promise<void>((done) => {
  signalBlockedClosed = done;
});
const checks: string[] = [];
const artifactHashes: Record<string, string> = {};
const additionalServices: ApiChannelService[] = [];
const parallelDownloads: { response: ServerResponse; text: string }[] = [];
let passed = false;

const assets = createServer((request, response) => {
  if (request.url?.startsWith("/steal")) redirectTargetCount += 1;
  assetCalls.push({ path: request.url ?? "", headers: request.headers, body: Buffer.alloc(0) });
  if (request.url?.startsWith("/parallel-")) {
    parallelDownloads.push({
      response,
      text: request.url.startsWith("/parallel-a") ? "parallel artifact A" : "parallel artifact B",
    });
    if (parallelDownloads.length === 2) {
      for (const pending of parallelDownloads) {
        pending.response.writeHead(200, { "content-type": "text/plain" });
        pending.response.end(pending.text);
      }
    } else if (parallelDownloads.length > 2) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.url.startsWith("/parallel-a") ? "parallel artifact A" : "parallel artifact B");
    }
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("remote artifact bytes");
});
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
const assetOrigin = await listen(assets);
const api = createServer((request, response) => {
  const path = request.url ?? "/";
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    calls.push({ path, headers: request.headers, body });
    const json = (value: ApiChannelValue) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/blocked") {
      signalBlockedStarted();
      response.on("close", () => {
        blockedClosed = true;
        signalBlockedClosed();
      });
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: `${assetOrigin}/steal` });
      response.end();
      return;
    }
    if (path === "/business-error") {
      json({ base_resp: { status_code: 1002, status_msg: secret }, ignored_secret: secret });
      return;
    }
    if (path === "/artifacts") {
      json({
        base_resp: { status_code: 0 },
        media: {
          url: signedUrl,
          hex: Buffer.from("hex audio bytes").toString("hex"),
          base64: Buffer.from("base64 image bytes").toString("base64"),
        },
        authorization: secret,
      });
      return;
    }
    if (path === "/redaction") {
      json({
        task_token: "unregistered-task-token",
        private_key: "unregistered-private-key",
        input_tokens: 41,
        output_tokens: 7,
        link: `https://files.example.test/${secret}/download?signature=private-query-value`,
        nested: { task_token: "nested-token", input_tokens: 3 },
      });
      return;
    }
    if (path === "/named-artifacts") {
      json({ base_resp: { status_code: 0 }, blob: Buffer.from("named artifact bytes").toString("base64") });
      return;
    }
    if (path === "/parallel-artifacts") {
      json({
        base_resp: { status_code: 0 },
        urls: [
          "https://files.example.test/parallel-a?signature=first",
          "https://files.example.test/parallel-b?signature=second",
        ],
      });
      return;
    }
    if (path === "/large-output") {
      json({
        base_resp: { status_code: 0 },
        text: longText,
        items: fullItems,
        task_token: "large-task-token",
        private_key: "large-private-key",
        input_tokens: 53,
        link: `https://files.example.test/${secret}/result?signature=long-private-query`,
      });
      return;
    }
    if (path === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 1, 2, 128, 255]));
      return;
    }
    if (path === "/text") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("00:00:00.000 --> 00:00:01.000\nFixture subtitle");
      return;
    }
    if (path === "/jobs" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      // Deliberately beyond Number.MAX_SAFE_INTEGER: the polling request must keep every digit.
      response.end('{"task_id":9223372036854775807,"base_resp":{"status_code":0}}');
      return;
    }
    if (path === "/numeric-jobs" && request.method === "POST") {
      json({ task_id: 17, base_resp: { status_code: 0 } });
      return;
    }
    if (path.startsWith("/jobs/")) {
      pollCount += 1;
      json({
        task: { status: pollCount === 1 ? "running" : "succeeded", content: pollCount === 1 ? {} : { url: signedUrl } },
        base_resp: { status_code: 0 },
      });
      return;
    }
    json({ base_resp: { status_code: 0 }, result: "accepted", echoed_key: secret });
  });
});
const origin = await listen(api);
const fetchApi: ApiChannelFetch = (url, init) => {
  const parsed = new URL(url);
  if (parsed.origin === "https://files.example.test") {
    assert.equal(init.headers, undefined, "Artifact fetches must not inherit request headers.");
    assert.equal(init.credentials, "omit");
    return fetch(`${assetOrigin}${parsed.pathname}${parsed.search}`, init);
  }
  assert.ok(
    parsed.origin === origin || parsed.origin === assetOrigin,
    "The fixture must not contact an external service.",
  );
  return fetch(url, init);
};

function parameter(name: string, type: ApiChannelParameter["type"], defaultJson = ""): ApiChannelParameter {
  return { name, type, required: defaultJson === "", description: "Fixture input", defaultJson };
}
function operation(id: string, overrides: Partial<ApiChannelOperation> = {}): ApiChannelOperation {
  return {
    id,
    name: id,
    description: "Local fixture operation",
    method: "GET",
    path: `/${id}`,
    bodyType: "none",
    body: "{}",
    query: [],
    parameters: [],
    readOnly: true,
    response: {
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
    },
    job: null,
    ...overrides,
  };
}
const baseResponse = operation("defaults").response;
const definition: ApiChannelDefinition = {
  name: "Fixture API",
  description: "All requests stay on loopback",
  baseUrl: origin,
  auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
  headers: [{ name: "X-Region", value: "fixture" }],
  artifactHosts: ["files.example.test"],
  operations: [
    operation("json", {
      method: "POST",
      bodyType: "json",
      body: '{"text":"{{text}}","count":"{{count}}","options":"{{options}}"}',
      parameters: [
        parameter("text", "string"),
        parameter("count", "number", "2"),
        parameter("options", "json", '{"nested":true}'),
      ],
      readOnly: false,
    }),
    operation("multipart", {
      method: "POST",
      bodyType: "multipart",
      body: '{"model":"{{model}}","file":"{{audio}}"}',
      parameters: [parameter("model", "string", '"asr-fixture"'), parameter("audio", "file")],
      readOnly: false,
    }),
    operation("json_files", {
      method: "POST",
      path: "/json-files",
      bodyType: "json",
      body: '{"image":"{{image}}","blob":"{{blob}}"}',
      parameters: [
        { ...parameter("image", "file"), fileEncoding: "data-url" },
        { ...parameter("blob", "file"), fileEncoding: "base64" },
      ],
      readOnly: false,
    }),
    operation("business", { path: "/business-error" }),
    operation("redirect"),
    operation("redaction", { response: { ...baseResponse, errorPath: "" } }),
    operation("artifacts", {
      response: {
        ...baseResponse,
        artifacts: [
          { path: "media.url", encoding: "url", fileName: "remote.txt", mimeType: "text/plain" },
          { path: "media.hex", encoding: "hex", fileName: "audio.mp3", mimeType: "audio/mpeg" },
          { path: "media.base64", encoding: "base64", fileName: "picture.png", mimeType: "image/png" },
        ],
      },
    }),
    operation("binary", {
      response: { ...baseResponse, format: "binary", fileName: "binary.dat", mimeType: "application/octet-stream" },
    }),
    operation("binary_error", {
      path: "/business-error",
      response: { ...baseResponse, format: "binary", fileName: "error.bin", mimeType: "application/octet-stream" },
    }),
    operation("named_artifact", {
      path: "/named-artifacts",
      parameters: [parameter("stem", "string")],
      response: {
        ...baseResponse,
        artifacts: [{ path: "blob", encoding: "base64", fileName: "{{stem}}.txt", mimeType: "text/plain" }],
      },
    }),
    operation("named_binary", {
      path: "/binary",
      parameters: [parameter("stem", "string")],
      response: { ...baseResponse, format: "binary", fileName: "{{stem}}.dat", mimeType: "application/octet-stream" },
    }),
    operation("parallel_artifacts", {
      path: "/parallel-artifacts",
      response: {
        ...baseResponse,
        artifacts: [{ path: "urls", encoding: "url", fileName: "parallel.txt", mimeType: "text/plain" }],
      },
    }),
    operation("large_output", { path: "/large-output" }),
    operation("text", { response: { ...baseResponse, format: "text", errorPath: "" } }),
    operation("create_job", {
      method: "POST",
      path: "/jobs",
      bodyType: "json",
      body: '{"prompt":"{{prompt}}"}',
      parameters: [parameter("prompt", "string")],
      readOnly: false,
      job: { idPath: "task_id", pollOperationId: "poll_job", pollParameter: "task_id" },
    }),
    operation("create_numeric_job", {
      method: "POST",
      path: "/numeric-jobs",
      bodyType: "json",
      body: "{}",
      readOnly: false,
      job: { idPath: "task_id", pollOperationId: "poll_job", pollParameter: "task_id" },
    }),
    operation("poll_job", {
      path: "/jobs/{{task_id}}",
      parameters: [parameter("task_id", "string")],
      response: {
        ...baseResponse,
        statusPath: "task.status",
        successValues: ["succeeded"],
        failureValues: ["failed"],
        artifacts: [{ path: "task.content.url", encoding: "url", fileName: "video.mp4", mimeType: "video/mp4" }],
      },
    }),
    operation("blocked", { method: "POST", bodyType: "json", body: "{}", readOnly: false }),
  ],
};
const store = new ApiChannelStore(storePath, cipher);
const service = new ApiChannelService(store, cache, fetchApi);
const owner = "fixture-agent";
const noFiles = new Map<string, GeneratedAttachmentSource>();

async function sealedKey(id: string): Promise<string> {
  const value = JSON.parse(await readFile(storePath, "utf8"));
  assert.ok(isDynamicRecord(value) && Array.isArray(value.channels));
  const entry = value.channels.find((item) => isDynamicRecord(item) && item.id === id);
  assert.ok(isDynamicRecord(entry) && typeof entry.sealedKey === "string");
  return entry.sealedKey;
}
async function artifactBytes(artifactId: string, name: string): Promise<Buffer> {
  const captured: { source?: GeneratedAttachmentSource } = {};
  const bytes = await Effect.runPromise(
    service.download(owner, artifactId, (opened) => {
      captured.source = opened;
      assert.equal(basename(opened.path), name);
      return Effect.promise(() => opened.handle.readFile());
    }),
  );
  assert.ok(captured.source);
  await assert.rejects(captured.source.handle.stat());
  artifactHashes[name] = createHash("sha256").update(bytes).digest("hex");
  return bytes;
}
async function readArtifact(artifactId: string, name: string, expected: Uint8Array | string): Promise<void> {
  assert.deepEqual(await artifactBytes(artifactId, name), Buffer.from(expected));
}

try {
  await Effect.runPromise(store.load());
  const templates = service.templates();
  assert.equal(templates.length, 5);
  for (const template of templates)
    assert.equal(service.validate(JSON.stringify(template.definition)).name, template.definition.name);
  checks.push("All five built-in templates pass the actual definition validator without contacting a service");

  const channel = await Effect.runPromise(
    service.save({ definitionJson: JSON.stringify(definition), enabled: true, apiKey: secret }),
  );
  assert.equal(channel.credentialStatus, "saved");
  assert.equal(JSON.stringify(service.list()).includes(secret), false);
  assert.equal((await readFile(storePath, "utf8")).includes(secret), false);
  const sealed = await sealedKey(channel.id);
  const renamed = { ...definition, name: "Fixture renamed" };
  await Effect.runPromise(
    service.save({ id: channel.id, definitionJson: JSON.stringify(renamed), enabled: true, apiKey: "" }),
  );
  assert.equal(await sealedKey(channel.id), sealed);
  const changedOrigin = { ...renamed, baseUrl: assetOrigin };
  await assert.rejects(
    Effect.runPromise(service.save({ id: channel.id, definitionJson: JSON.stringify(changedOrigin), enabled: true })),
  );
  await assert.rejects(
    Effect.runPromise(
      service.save({ id: channel.id, definitionJson: JSON.stringify(changedOrigin), enabled: true, apiKey: "   " }),
    ),
  );
  assert.equal(service.list().find((item) => item.id === channel.id)?.definition.baseUrl, origin);
  assert.equal(await sealedKey(channel.id), sealed);
  const moved = await Effect.runPromise(
    service.save({ id: channel.id, definitionJson: JSON.stringify(changedOrigin), enabled: true, apiKey: replacement }),
  );
  assert.equal(moved.definition.baseUrl, assetOrigin);
  assert.notEqual(await sealedKey(moved.id), sealed);
  await Effect.runPromise(
    service.save({ id: channel.id, definitionJson: JSON.stringify(renamed), enabled: true, apiKey: secret }),
  );
  const draft = await Effect.runPromise(
    service.createDraft(owner, JSON.stringify({ ...definition, name: "AI draft" })),
  );
  assert.equal(draft.source, "agent");
  assert.equal(draft.enabled, false);
  assert.equal(draft.credentialStatus, "missing");
  await assert.rejects(Effect.runPromise(service.setEnabled(draft.id, true)));
  await assert.rejects(
    Effect.runPromise(service.createDraft(owner, JSON.stringify({ ...definition, apiKey: secret }))),
  );
  const beforeDraft = calls.length;
  await assert.rejects(
    Effect.runPromise(
      service.call(
        owner,
        { channelId: draft.id, operationId: "json", valuesJson: '{"text":"draft"}' },
        noFiles,
        "draft-refused",
      ),
    ),
  );
  assert.equal(calls.length, beforeDraft);
  checks.push(
    "AES-GCM credentials stay out of metadata/disk plaintext; same-origin edits retain ciphertext, changed origins reject absent or whitespace keys, and AI drafts stay disabled",
  );

  const tamperedEnvelope = JSON.parse(await readFile(storePath, "utf8"));
  assert.ok(isDynamicRecord(tamperedEnvelope) && Array.isArray(tamperedEnvelope.channels));
  const tamperedChannel = tamperedEnvelope.channels.find((entry) => isDynamicRecord(entry) && entry.id === channel.id);
  assert.ok(isDynamicRecord(tamperedChannel) && isDynamicRecord(tamperedChannel.definition));
  const changedChannel = { ...tamperedChannel, definition: { ...tamperedChannel.definition, baseUrl: assetOrigin } };
  const changedEnvelope = {
    ...tamperedEnvelope,
    channels: tamperedEnvelope.channels.map((entry) => (entry === tamperedChannel ? changedChannel : entry)),
  };
  const tamperedPath = join(root, "tampered-channel-origin.json");
  await writeFile(tamperedPath, JSON.stringify(changedEnvelope));
  const tamperedStore = new ApiChannelStore(tamperedPath, cipher);
  await Effect.runPromise(tamperedStore.load());
  assert.equal(tamperedStore.entry(channel.id).credentialStatus, "unreadable");
  const tamperedService = new ApiChannelService(tamperedStore, join(root, "tampered-cache"), fetchApi);
  additionalServices.push(tamperedService);
  const beforeTampered = calls.length + assetCalls.length;
  await assert.rejects(
    Effect.runPromise(
      tamperedService.call(
        owner,
        { channelId: channel.id, operationId: "json", valuesJson: '{"text":"must not send"}' },
        noFiles,
        "tampered-origin",
      ),
    ),
  );
  assert.equal(calls.length + assetCalls.length, beforeTampered);
  checks.push(
    "Changing a saved base URL on disk cannot reuse origin-bound encrypted credentials or send them to the changed host",
  );

  const invoke = (operationId: string, values: ApiChannelValue = {}, requestId = operationId) =>
    service.call(owner, { channelId: channel.id, operationId, valuesJson: JSON.stringify(values) }, noFiles, requestId);
  const [first, duplicate] = await Promise.all([
    Effect.runPromise(invoke("json", { text: 'quoted " text\n下一行' }, "one-create")),
    Effect.runPromise(invoke("json", { text: 'quoted " text\n下一行' }, "one-create")),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.status, "completed");
  assert.equal(calls.filter((call) => call.path === "/json").length, 1);
  const jsonCall = calls.find((call) => call.path === "/json");
  assert.ok(jsonCall);
  assert.equal(jsonCall.headers.authorization, `Bearer ${secret}`);
  assert.equal(jsonCall.headers["x-region"], "fixture");
  assert.deepEqual(JSON.parse(jsonCall.body.toString()), {
    text: 'quoted " text\n下一行',
    count: 2,
    options: { nested: true },
  });
  assert.equal(JSON.stringify(first).includes(secret), false);
  const reopenedStore = new ApiChannelStore(storePath, cipher);
  await Effect.runPromise(reopenedStore.load());
  const reopened = new ApiChannelService(reopenedStore, cache, fetchApi);
  additionalServices.push(reopened);
  assert.deepEqual(
    await Effect.runPromise(
      reopened.call(
        owner,
        { channelId: channel.id, operationId: "json", valuesJson: JSON.stringify({ text: 'quoted " text\n下一行' }) },
        noFiles,
        "one-create",
      ),
    ),
    first,
  );
  assert.equal(calls.filter((call) => call.path === "/json").length, 1);
  checks.push(
    "Authenticated JSON requests preserve JSON types and escaped text; concurrent and reopened retries share a durable result without another POST",
  );

  const headerChannel = await Effect.runPromise(
    service.save({
      definitionJson: JSON.stringify({
        ...definition,
        name: "Header auth",
        auth: { type: "header", name: "X-Api-Key", prefix: "Token " },
      }),
      enabled: true,
      apiKey: secret,
    }),
  );
  await Effect.runPromise(
    service.call(
      owner,
      { channelId: headerChannel.id, operationId: "json", valuesJson: '{"text":"header auth"}' },
      noFiles,
      "header-auth",
    ),
  );
  const headerCall = calls.at(-1);
  assert.equal(headerCall?.headers["x-api-key"], `Token ${secret}`);
  assert.equal(headerCall?.headers.authorization, undefined);
  const queryChannel = await Effect.runPromise(
    service.save({
      definitionJson: JSON.stringify({
        ...definition,
        name: "Query auth",
        auth: { type: "query", name: "access_token", prefix: "" },
      }),
      enabled: true,
      apiKey: secret,
    }),
  );
  await Effect.runPromise(
    service.call(
      owner,
      { channelId: queryChannel.id, operationId: "json", valuesJson: '{"text":"query auth"}' },
      noFiles,
      "query-auth",
    ),
  );
  const queryCall = calls.at(-1);
  assert.ok(queryCall);
  assert.equal(new URL(queryCall.path, origin).searchParams.get("access_token"), secret);
  assert.equal(queryCall.headers.authorization, undefined);
  checks.push("Header and query authentication place the encrypted credential only in the configured request field");

  const audio = join(root, 'fixture"audio.wav');
  await writeFile(audio, "audio fixture bytes\u0000\u00ff");
  const handle = await open(audio, "r");
  try {
    const multipart = await Effect.runPromise(
      service.call(
        owner,
        { channelId: channel.id, operationId: "multipart", valuesJson: JSON.stringify({ audio }) },
        new Map([["audio", { path: audio, handle }]]),
        "upload",
      ),
    );
    assert.equal(multipart.status, "completed");
    const uploaded = calls.find((call) => call.path === "/multipart");
    assert.ok(uploaded);
    assert.match(String(uploaded.headers["content-type"]), /^multipart\/form-data; boundary=openbot-/u);
    assert.ok(uploaded.body.includes(await readFile(audio)));
    assert.match(uploaded.body.toString(), /name="model"\r\n\r\nasr-fixture/u);
    assert.match(uploaded.body.toString(), /filename="fixture_audio.wav"/u);
    assert.ok((await handle.stat()).isFile(), "The service borrows the input handle; the gateway owns its close.");
  } finally {
    await handle.close();
  }
  checks.push(
    "Multipart bodies stream from a borrowed regular-file handle with sanitized names and typed default fields",
  );

  const imagePath = join(root, "image.png");
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 19]);
  await writeFile(imagePath, imageBytes);
  const imageHandle = await open(imagePath, "r");
  try {
    const source = { path: imagePath, handle: imageHandle };
    const jsonFiles = await Effect.runPromise(
      service.call(
        owner,
        {
          channelId: channel.id,
          operationId: "json_files",
          valuesJson: JSON.stringify({ image: imagePath, blob: imagePath }),
        },
        new Map([
          ["image", source],
          ["blob", source],
        ]),
        "json-file-input",
      ),
    );
    assert.equal(jsonFiles.status, "completed");
    const sent = calls.find((call) => call.path === "/json-files");
    assert.ok(sent);
    assert.deepEqual(JSON.parse(sent.body.toString()), {
      image: `data:image/png;base64,${imageBytes.toString("base64")}`,
      blob: imageBytes.toString("base64"),
    });
    assert.deepEqual(await imageHandle.readFile(), imageBytes);
  } finally {
    await imageHandle.close();
  }
  checks.push(
    "JSON file parameters encode data URLs or base64 from borrowed handles and leave those handles readable for their owner",
  );

  const rejected = await Effect.runPromise(invoke("business"));
  assert.equal(rejected.status, "failed");
  assert.match(rejected.message ?? "", /1002/u);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  const binaryRejected = await Effect.runPromise(invoke("binary_error"));
  assert.equal(binaryRejected.status, "failed");
  assert.equal(binaryRejected.artifacts.length, 0);
  assert.match(binaryRejected.message ?? "", /1002/u);
  const redirected = await Effect.runPromise(invoke("redirect"));
  assert.equal(redirected.status, "failed");
  assert.equal(redirectTargetCount, 0);
  checks.push(
    "HTTP 200 business errors are failures even on a binary operation, and HTTP redirects are not followed with channel credentials",
  );

  const redacted = await Effect.runPromise(invoke("redaction"));
  assert.equal(redacted.status, "completed");
  assert.ok(isDynamicRecord(redacted.output) && isDynamicRecord(redacted.output.nested));
  assert.equal(redacted.output.task_token, "[redacted]");
  assert.equal(redacted.output.private_key, "[redacted]");
  assert.equal(redacted.output.input_tokens, 41);
  assert.equal(redacted.output.output_tokens, 7);
  assert.equal(redacted.output.nested.task_token, "[redacted]");
  assert.equal(redacted.output.nested.input_tokens, 3);
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.equal(JSON.stringify(redacted).includes("private-query-value"), false);
  checks.push(
    "Task tokens, private keys and registered secrets in URL paths/queries are redacted while numeric token usage remains available",
  );

  const generated = await Effect.runPromise(invoke("artifacts"));
  assert.equal(generated.status, "completed");
  assert.equal(generated.artifacts.length, 3);
  assert.equal(JSON.stringify(generated).includes("fixture-signed-download"), false);
  assert.equal(JSON.stringify(generated).includes(Buffer.from("hex audio bytes").toString("hex")), false);
  assert.equal(JSON.stringify(generated).includes(Buffer.from("base64 image bytes").toString("base64")), false);
  assert.equal((await readFile(storePath, "utf8")).includes("fixture-signed-download"), false);
  const byName = (run: ApiChannelRun, name: string) => {
    const artifact = run.artifacts.find((artifact) => artifact.fileName === name);
    assert.ok(artifact, `Missing fixture artifact ${name}`);
    return artifact.id;
  };
  const remoteArtifact = byName(generated, "remote.txt");
  await assert.rejects(Effect.runPromise(service.download("other-agent", remoteArtifact, () => Effect.void)));
  await readArtifact(remoteArtifact, "remote.txt", "remote artifact bytes");
  await readArtifact(remoteArtifact, "remote.txt", "remote artifact bytes");
  assert.equal(assetCalls.filter((call) => call.path.startsWith("/asset")).length, 1);
  assert.equal(assetCalls[0]?.headers.authorization, undefined);
  assert.equal(assetCalls[0]?.headers.cookie, undefined);
  await readArtifact(byName(generated, "audio.mp3"), "audio.mp3", "hex audio bytes");
  await readArtifact(byName(generated, "picture.png"), "picture.png", "base64 image bytes");
  const binary = await Effect.runPromise(invoke("binary"));
  assert.equal(binary.status, "completed");
  await readArtifact(byName(binary, "binary.dat"), "binary.dat", new Uint8Array([0, 1, 2, 128, 255]));
  const subtitle = await Effect.runPromise(invoke("text"));
  assert.equal(subtitle.output, "00:00:00.000 --> 00:00:01.000\nFixture subtitle");
  checks.push(
    "URL, hex, base64 and binary artifacts produce real files; downloads are owner-bound, cached, credential-free and closed after consumption",
  );

  const named = await Effect.runPromise(invoke("named_artifact", { stem: "transcript" }));
  assert.equal(named.status, "completed");
  await readArtifact(byName(named, "transcript.txt"), "transcript.txt", "named artifact bytes");
  const namedBinary = await Effect.runPromise(invoke("named_binary", { stem: "capture" }));
  assert.equal(namedBinary.status, "completed");
  await readArtifact(byName(namedBinary, "capture.dat"), "capture.dat", new Uint8Array([0, 1, 2, 128, 255]));
  checks.push("Artifact and binary file-name templates resolve input parameters before their files are delivered");

  const parallel = await Effect.runPromise(invoke("parallel_artifacts"));
  assert.equal(parallel.artifacts.length, 2);
  const firstParallel = byName(parallel, "parallel.txt");
  const secondParallel = byName(parallel, "2-parallel.txt");
  await Promise.all([
    readArtifact(firstParallel, "parallel.txt", "parallel artifact A"),
    readArtifact(secondParallel, "2-parallel.txt", "parallel artifact B"),
  ]);
  const firstPath = store.artifact(firstParallel)?.artifact.path;
  const secondPath = store.artifact(secondParallel)?.artifact.path;
  assert.ok(firstPath && secondPath && firstPath !== secondPath);
  await Promise.all([
    readArtifact(firstParallel, "parallel.txt", "parallel artifact A"),
    readArtifact(secondParallel, "2-parallel.txt", "parallel artifact B"),
  ]);
  assert.equal(assetCalls.filter((call) => call.path.startsWith("/parallel-")).length, 2);
  checks.push("Concurrent downloads keep both artifacts' distinct cached files and do not fetch either result twice");

  const large = await Effect.runPromise(invoke("large_output"));
  assert.equal(large.status, "completed");
  assert.equal(large.outputTruncated, true);
  assert.ok(isDynamicRecord(large.output));
  assert.equal(typeof large.output.text === "string" ? large.output.text.length : null, 32_000);
  assert.ok(Array.isArray(large.output.items));
  assert.equal(large.output.items.length, 256);
  const fullJson = JSON.parse((await artifactBytes(byName(large, "response.json"), "response.json")).toString());
  assert.ok(isDynamicRecord(fullJson) && Array.isArray(fullJson.items));
  assert.equal(fullJson.text, longText);
  assert.deepEqual(fullJson.items, fullItems);
  assert.equal(fullJson.task_token, "[redacted]");
  assert.equal(fullJson.private_key, "[redacted]");
  assert.equal(fullJson.input_tokens, 53);
  assert.equal(JSON.stringify(fullJson).includes(secret), false);
  assert.equal(JSON.stringify(fullJson).includes("long-private-query"), false);
  checks.push(
    "Truncated tool output is marked and has a complete downloadable JSON artifact with the same secret redaction",
  );

  const uncachedRun = await Effect.runPromise(invoke("artifacts", {}, "history-uncached-artifact"));
  const uncachedArtifact = byName(uncachedRun, "remote.txt");
  assert.equal(store.artifact(uncachedArtifact)?.artifact.path, undefined);
  const beforeHistory = calls.length + assetCalls.length;
  const history = await Effect.runPromise(service.listRuns(channel.id));
  const listed = history.find((entry) => entry.id === generated.id);
  assert.ok(listed);
  assert.equal(listed.artifactCount, generated.artifacts.length);
  assert.ok(listed.createdAt && Number.isFinite(Date.parse(listed.createdAt)));
  assert.ok(listed.updatedAt && Number.isFinite(Date.parse(listed.updatedAt)));
  assert.deepEqual(await Effect.runPromise(service.readForUi(generated.id)), generated);
  assert.equal(JSON.stringify(history).includes(secret), false);
  assert.equal(JSON.stringify(history).includes("fixture-signed-download"), false);
  assert.equal(JSON.stringify(history).includes(cache), false);
  assert.equal(calls.length + assetCalls.length, beforeHistory);
  await assert.rejects(Effect.runPromise(service.poll("other-agent", generated.id)));
  await assert.rejects(Effect.runPromise(service.download("other-agent", remoteArtifact, () => Effect.void)));
  assert.equal(calls.length + assetCalls.length, beforeHistory);
  checks.push(
    "Local run history lists and reads stored output without HTTP, while agent tools retain caller ownership checks",
  );

  await Effect.runPromise(service.setEnabled(channel.id, false));
  const beforeDisabledDownload = calls.length + assetCalls.length;
  await readArtifact(remoteArtifact, "remote.txt", "remote artifact bytes");
  assert.deepEqual(
    await Effect.runPromise(
      service.downloadForUi(remoteArtifact, (source) => Effect.promise(() => source.handle.readFile())),
    ),
    Buffer.from("remote artifact bytes"),
  );
  await assert.rejects(Effect.runPromise(service.download(owner, uncachedArtifact, () => Effect.void)));
  await assert.rejects(Effect.runPromise(service.download("other-agent", remoteArtifact, () => Effect.void)));
  assert.equal(calls.length + assetCalls.length, beforeDisabledDownload);
  await Effect.runPromise(service.setEnabled(channel.id, true));
  checks.push(
    "A disabled channel still serves cached output locally; an uncached URL and another agent's download remain refused",
  );

  const job = await Effect.runPromise(invoke("create_job", { prompt: "fixture video" }, "job-create"));
  assert.equal(job.status, "pending");
  assert.notEqual(job.id, "9223372036854775807");
  const beforeForeign = calls.length;
  await assert.rejects(Effect.runPromise(service.poll("other-agent", job.id)));
  assert.equal(calls.length, beforeForeign);
  assert.equal((await Effect.runPromise(service.poll(owner, job.id))).status, "pending");
  const complete = await Effect.runPromise(service.poll(owner, job.id));
  assert.equal(complete.status, "completed");
  assert.ok(calls.some((call) => call.path === "/jobs/9223372036854775807"));
  assert.equal(calls.filter((call) => call.path === "/jobs").length, 1);
  const numericJob = await Effect.runPromise(invoke("create_numeric_job", {}, "numeric-job"));
  assert.equal(numericJob.status, "pending");
  const numericComplete = await Effect.runPromise(service.poll(owner, numericJob.id));
  assert.equal(numericComplete.status, "completed");
  assert.ok(calls.some((call) => call.path === "/jobs/17"));
  const outstanding = await Effect.runPromise(invoke("create_job", { prompt: "second fixture" }, "second-job"));
  const changed = { ...renamed, description: "Changed configuration revision" };
  await Effect.runPromise(service.save({ id: channel.id, definitionJson: JSON.stringify(changed), enabled: true }));
  const beforeRevision = calls.length + assetCalls.length;
  await assert.rejects(Effect.runPromise(service.poll(owner, outstanding.id)));
  await readArtifact(remoteArtifact, "remote.txt", "remote artifact bytes");
  await assert.rejects(Effect.runPromise(service.download(owner, uncachedArtifact, () => Effect.void)));
  assert.deepEqual(await Effect.runPromise(service.readForUi(generated.id)), generated);
  assert.equal(calls.length + assetCalls.length, beforeRevision);
  checks.push(
    "Opaque jobs bind the caller and revision and preserve numeric IDs; a changed channel keeps cached output local but cannot poll or fetch old uncached URLs",
  );

  const stop = new AbortController();
  const running = Effect.runFork(
    withApiChannelRequestCancellation(invoke("blocked", {}, "cancel-request"), stop.signal),
  );
  await blockedStarted;
  const beforeActiveHistory = calls.length + assetCalls.length;
  const activeHistory = (await Effect.runPromise(service.listRuns(channel.id))).find(
    (entry) => entry.operationId === "blocked",
  );
  assert.ok(activeHistory);
  assert.equal(activeHistory.status, "pending");
  assert.equal((await Effect.runPromise(service.readForUi(activeHistory.id))).status, "pending");
  assert.equal(calls.length + assetCalls.length, beforeActiveHistory);
  // Capture the durable state that would survive a process exit before its HTTP result arrived.
  const crashPath = join(root, "crashed-pending-store.json");
  await writeFile(crashPath, await readFile(storePath));
  stop.abort();
  assert.ok(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(running))));
  await blockedEnded;
  assert.equal(blockedClosed, true);
  const retried = await Effect.runPromise(invoke("blocked", {}, "cancel-request"));
  assert.equal(retried.status, "unknown");
  assert.equal(calls.filter((call) => call.path === "/blocked").length, 1);
  checks.push(
    "Cancelling a pending request aborts HTTP and records an unknown, non-replayed outcome for the same request ID",
  );

  const crashStore = new ApiChannelStore(crashPath, cipher);
  await Effect.runPromise(crashStore.load());
  const crashService = new ApiChannelService(crashStore, join(root, "crash-artifacts"), fetchApi);
  additionalServices.push(crashService);
  const crashEnvelope = JSON.parse(await readFile(crashPath, "utf8"));
  assert.ok(isDynamicRecord(crashEnvelope) && Array.isArray(crashEnvelope.runs));
  const pendingRecord = crashEnvelope.runs.find(
    (entry) =>
      isDynamicRecord(entry) &&
      typeof entry.id === "string" &&
      crashStore.run(entry.id)?.result.operationId === "blocked",
  );
  assert.ok(isDynamicRecord(pendingRecord) && typeof pendingRecord.id === "string");
  assert.equal(crashStore.run(pendingRecord.id)?.result.status, "pending");
  assert.equal(crashStore.run(pendingRecord.id)?.job, null);
  const beforeRecovery = calls.length + assetCalls.length;
  const crashBytesBeforeRead = await readFile(crashPath, "utf8");
  assert.equal((await Effect.runPromise(crashService.readForUi(pendingRecord.id))).status, "unknown");
  assert.equal(
    (await Effect.runPromise(crashService.listRuns(channel.id))).find((entry) => entry.id === pendingRecord.id)?.status,
    "unknown",
  );
  assert.equal(crashStore.run(pendingRecord.id)?.result.status, "pending");
  assert.equal(await readFile(crashPath, "utf8"), crashBytesBeforeRead);
  assert.equal(calls.length + assetCalls.length, beforeRecovery);
  assert.equal((await Effect.runPromise(crashService.poll(owner, pendingRecord.id))).status, "unknown");
  const recoveredRetry = await Effect.runPromise(
    crashService.call(
      owner,
      { channelId: channel.id, operationId: "blocked", valuesJson: "{}" },
      noFiles,
      "cancel-request",
    ),
  );
  assert.equal(recoveredRetry.status, "unknown");
  assert.equal(calls.length + assetCalls.length, beforeRecovery);
  checks.push(
    "A recovered pending request is shown as unknown by local history without writes or HTTP, and explicit polling/retry does not submit it again",
  );

  const legacyEnvelope = JSON.parse(await readFile(storePath, "utf8"));
  assert.ok(isDynamicRecord(legacyEnvelope) && Array.isArray(legacyEnvelope.runs));
  const legacyRuns = legacyEnvelope.runs.map((entry) => {
    assert.ok(isDynamicRecord(entry) && typeof entry.sealed === "string");
    const decrypted = JSON.parse(cipher.decrypt(Buffer.from(entry.sealed, "base64")));
    assert.ok(isDynamicRecord(decrypted));
    const withoutDates = Object.fromEntries(
      Object.entries(decrypted).filter(([key]) => !["createdAt", "updatedAt"].includes(key)),
    );
    return { ...entry, sealed: cipher.encrypt(JSON.stringify(withoutDates)).toString("base64") };
  });
  const legacyPath = join(root, "legacy-run-timestamps.json");
  await writeFile(legacyPath, JSON.stringify({ ...legacyEnvelope, runs: legacyRuns }));
  const legacyStore = new ApiChannelStore(legacyPath, cipher);
  await Effect.runPromise(legacyStore.load());
  const legacyService = new ApiChannelService(legacyStore, cache, fetchApi);
  additionalServices.push(legacyService);
  const beforeLegacyHistory = calls.length + assetCalls.length;
  const legacyBytesBeforeRead = await readFile(legacyPath, "utf8");
  const legacyHistory = await Effect.runPromise(legacyService.listRuns(channel.id));
  assert.ok(legacyHistory.some((entry) => entry.id === first.id));
  assert.ok(legacyHistory.every((entry) => entry.createdAt === null && entry.updatedAt === null));
  assert.deepEqual(await Effect.runPromise(legacyService.readForUi(first.id)), first);
  assert.equal(await readFile(legacyPath, "utf8"), legacyBytesBeforeRead);
  assert.equal(calls.length + assetCalls.length, beforeLegacyHistory);
  checks.push(
    "Older encrypted runs without timestamps remain readable with null dates and are not rewritten during history reads",
  );

  await Effect.runPromise(service.delete(channel.id));
  const beforeDeletedHistory = calls.length + assetCalls.length;
  assert.deepEqual(await Effect.runPromise(service.readForUi(generated.id)), generated);
  const deletedHistory = await Effect.runPromise(service.listRuns(channel.id));
  assert.equal(deletedHistory.find((entry) => entry.id === generated.id)?.channelName, null);
  await readArtifact(remoteArtifact, "remote.txt", "remote artifact bytes");
  assert.deepEqual(
    await Effect.runPromise(
      service.downloadForUi(remoteArtifact, (source) => Effect.promise(() => source.handle.readFile())),
    ),
    Buffer.from("remote artifact bytes"),
  );
  await assert.rejects(Effect.runPromise(service.download(owner, uncachedArtifact, () => Effect.void)));
  await assert.rejects(Effect.runPromise(service.download("other-agent", remoteArtifact, () => Effect.void)));
  assert.equal(calls.length + assetCalls.length, beforeDeletedHistory);
  checks.push(
    "Deleting a channel preserves its local history and cached artifacts, without granting access to uncached URLs or another agent",
  );
  assert.equal(redactText(secret).includes(secret), false);
  passed = true;
} finally {
  await Effect.runPromise(service.close());
  for (const extra of additionalServices) await Effect.runPromise(extra.close());
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({ passed, checks, templateCount: service.templates().length, httpRequests: calls.length, artifactHashes, blockedClosed }, null, 2)}\n`,
  );
  api.closeAllConnections();
  assets.closeAllConnections();
  await Promise.all([
    new Promise<void>((done) => api.close(() => done())),
    new Promise<void>((done) => assets.close(() => done())),
  ]);
  await rm(root, { recursive: true, force: true });
}
logger.info("API channel service HTTP checks passed.");
