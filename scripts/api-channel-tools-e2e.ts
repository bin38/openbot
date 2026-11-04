// Exercises the real API tool file gateway, loopback HTTP, cancellation, and SQLite attachment
// delivery. The external API service port is a fixture; no model, account, or cloud key is used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ApiChannelDefinition,
  ApiChannelOperation,
  ApiChannelRun,
  ApiChannelSummary,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Fiber } from "effect";
import {
  type ApiChannelTools,
  callApiChannelWithFiles,
  handleApiChannelTool,
  parseApiChannelToolRequest,
  withApiChannelRequestCancellation,
} from "../src/backend/agent/api-channel-tools";
import { AttachmentGateway } from "../src/backend/agent/attachment-gateway";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { responseAttachmentMessageId } from "../src/backend/agent/delivery-content";
import { AgentStore } from "../src/backend/agent-store";
import { attachmentFailure } from "../src/backend/attachment-effects";
import type { GeneratedAttachmentSource } from "../src/backend/attachment-files";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const logger = createOpenBotLogger("api-channel-tools-e2e");
const output = resolve(import.meta.dirname, "../.openbot-build/api-channel-tools-e2e/report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-api-channel-tools-"));
const data = join(root, "data");
const database = new OpenBotDatabase(data);
const store = new AgentStore(data, join(root, "home"), database);
const mailbox = new MailboxStore(data, store.sharedRoot, database);
const conversation = new ConversationRuntime(
  store,
  () => {},
  () => store.list(),
);
const gateway = new AttachmentGateway({
  conversation,
  mailbox,
  sharedRoot: store.sharedRoot,
  hooks: { emit: () => {}, emitError: () => {} },
});
const checks: string[] = [];
let passed = false;
let requestCount = 0;
let receivedBody = "";
let lastInput: GeneratedAttachmentSource | undefined;
let owner = "";
let cancelled = false;
let downloadCount = 0;
let releaseBlocked = () => {};
const blockedStarted = new Promise<void>((resolve) => {
  releaseBlocked = resolve;
});
let releaseBlockedClosed = () => {};
const blockedClosed = new Promise<void>((resolve) => {
  releaseBlockedClosed = resolve;
});
const http = createServer((request, response) => {
  requestCount += 1;
  if (request.url === "/blocked") {
    releaseBlocked();
    response.on("close", () => {
      cancelled = true;
      releaseBlockedClosed();
    });
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    receivedBody = Buffer.concat(chunks).toString();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(receivedBody) }));
  });
});
await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
const address = http.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

const definition: ApiChannelDefinition = {
  name: "Fixture speech API",
  description: "Local file transfer fixture",
  baseUrl: origin,
  auth: { type: "none", name: "", prefix: "" },
  headers: [],
  artifactHosts: [],
  operations: ["send", "blocked"].map(
    (id): ApiChannelOperation => ({
      id,
      name: id,
      description: "Receive a workspace file",
      method: "POST",
      path: `/${id}`,
      bodyType: "multipart",
      body: '{"file":"{{audio}}"}',
      query: [],
      parameters: [{ name: "audio", type: "file", required: true, description: "Fixture audio file", defaultJson: "" }],
      readOnly: false,
      response: {
        format: "json",
        resultPath: "",
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
    }),
  ),
};
const channel: ApiChannelSummary = {
  id: "fixture-api",
  definition,
  enabled: true,
  source: "user",
  credentialStatus: "not-required",
  updatedAt: new Date().toISOString(),
};
const completed = (operationId: string): ApiChannelRun => ({
  id: "run-fixture",
  channelId: channel.id,
  operationId,
  status: "completed",
  output: { ok: true },
  artifacts: [{ id: "artifact-fixture", fileName: "transcript.txt", mimeType: "text/plain" }],
  message: null,
});
const denied = () => ({ message: "The API fixture refused this request." });
const artifact = join(root, "transcript.txt");
const tools: ApiChannelTools = {
  list: () => [channel],
  templates: () => [
    {
      id: "fixture-template",
      name: "Fixture",
      description: "A local template",
      docsUrl: "https://example.test/docs",
      definition,
    },
  ],
  createDraft: (_agentId, definitionJson) =>
    Effect.try({
      try: () => {
        assert.ok(isDynamicRecord(JSON.parse(definitionJson)));
        const draft: ApiChannelSummary = { ...channel, id: "draft-fixture", enabled: false, source: "agent" };
        return draft;
      },
      catch: denied,
    }),
  call: (agentId, input, files, requestId) =>
    Effect.tryPromise({
      try: async (signal) => {
        assert.equal(agentId, owner);
        assert.equal(requestId, "fixture-request");
        const source = files.get("audio");
        assert.ok(source);
        lastInput = source;
        const response = await fetch(`${origin}/${input.operationId}`, {
          method: "POST",
          body: await source.handle.readFile(),
          signal,
        });
        assert.equal(response.status, 200);
        return completed(input.operationId);
      },
      catch: denied,
    }),
  poll: (agentId, runId) =>
    agentId === owner && runId === "run-fixture" ? Effect.succeed(completed("send")) : Effect.fail(denied()),
  download: (agentId, artifactId, consume) => {
    if (agentId !== owner || artifactId !== "artifact-fixture") return Effect.fail(denied());
    downloadCount += 1;
    return Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => open(artifact, "r"), catch: denied }),
      (handle) => consume({ path: artifact, handle }),
      (handle) => Effect.promise(() => handle.close()),
    );
  },
};

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agent = await runCauseEffect(
    store.createAgent({ name: "API files", description: "Fixture", avatarSeed: "api", avatarHue: null }),
  );
  owner = agent.id;
  const publicThreadId = store.ensureThreadIdNow(agent.id);
  await writeFile(artifact, "A generated transcript.\n");
  const inputPath = join(agent.workspacePath, "sample.wav");
  await writeFile(inputPath, "local fixture recording");
  const input = { channelId: channel.id, operationId: "send", valuesJson: JSON.stringify({ audio: inputPath }) };
  const result = await Effect.runPromise(callApiChannelWithFiles(agent.id, input, tools, gateway, "fixture-request"));
  assert.equal(result.status, "completed");
  assert.equal(receivedBody, "local fixture recording");
  assert.ok(lastInput);
  await assert.rejects(lastInput.handle.stat());
  checks.push(
    "The tool sends a real workspace file through loopback HTTP and closes its borrowed handle after success",
  );

  const beforeRejected = requestCount;
  const outside = join(root, "outside.txt");
  await writeFile(outside, "private fixture");
  await assert.rejects(
    Effect.runPromise(
      callApiChannelWithFiles(
        agent.id,
        { ...input, valuesJson: JSON.stringify({ audio: outside }) },
        tools,
        gateway,
        "fixture-request",
      ),
    ),
  );
  const link = join(agent.workspacePath, "linked.wav");
  await symlink(outside, link);
  await assert.rejects(
    Effect.runPromise(
      callApiChannelWithFiles(
        agent.id,
        { ...input, valuesJson: JSON.stringify({ audio: link }) },
        tools,
        gateway,
        "fixture-request",
      ),
    ),
  );
  assert.equal(requestCount, beforeRejected);
  assert.equal(
    parseApiChannelToolRequest("call_api_channel", { ...input, agentId: "another-agent", apiKey: "not-accepted" }),
    null,
  );
  checks.push(
    "Outside and symlink inputs are rejected before HTTP; tool arguments cannot override the caller or supply credentials",
  );

  const callbacks = {
    call: (value: typeof input) => callApiChannelWithFiles(agent.id, value, tools, gateway, "fixture-request"),
    download: (artifactId: string) =>
      gateway
        .attachProducedFile(
          agent.id,
          { threadId: "api-thread", turnId: "api-turn", callId: "api-file" },
          responseAttachmentMessageId("api-thread", "api-turn", "api-file"),
          (consume) => tools.download(agent.id, artifactId, consume).pipe(Effect.mapError(attachmentFailure)),
        )
        .pipe(Effect.mapError(denied)),
  };
  const listing = await Effect.runPromise(
    handleApiChannelTool({ tool: "list_api_channels" }, agent.id, tools, callbacks),
  );
  const summary = listing.contentItems.find((item) => item.type === "inputText");
  assert.ok(summary && summary.type === "inputText");
  assert.equal(summary.text.includes('"baseUrl"'), false);
  const template = await Effect.runPromise(
    handleApiChannelTool({ tool: "list_api_channels", templateId: "fixture-template" }, agent.id, tools, callbacks),
  );
  assert.equal(template.success, true);
  const draft = await Effect.runPromise(
    handleApiChannelTool(
      { tool: "create_api_channel_draft", definitionJson: JSON.stringify(definition) },
      agent.id,
      tools,
      callbacks,
    ),
  );
  assert.equal(draft.success, true);
  const attachment = await Effect.runPromise(
    handleApiChannelTool(
      { tool: "download_api_channel_artifact", artifactId: "artifact-fixture" },
      agent.id,
      tools,
      callbacks,
    ),
  );
  assert.equal(attachment.success, true);
  await Effect.runPromise(
    handleApiChannelTool(
      { tool: "download_api_channel_artifact", artifactId: "artifact-fixture" },
      agent.id,
      tools,
      callbacks,
    ),
  );
  assert.equal(downloadCount, 1);
  const saved = database
    .readConversation(agent.id, publicThreadId)
    .messages.find((message) => message.id === responseAttachmentMessageId("api-thread", "api-turn", "api-file"));
  assert.ok(saved?.attachments?.[0]);
  const managed = await runCauseEffect(mailbox.resolveAttachment(saved.attachments[0].id));
  assert.ok(managed);
  assert.equal(await readFile(managed.path, "utf8"), "A generated transcript.\n");
  assert.equal(JSON.stringify(attachment).includes(root), false);
  checks.push(
    "Template discovery and disabled draft responses are available; an artifact commits to SQLite/chat once without exposing a private path",
  );

  const stop = new AbortController();
  const task = Effect.runFork(
    withApiChannelRequestCancellation(
      callApiChannelWithFiles(agent.id, { ...input, operationId: "blocked" }, tools, gateway, "fixture-request"),
      stop.signal,
    ),
  );
  await blockedStarted;
  stop.abort();
  assert.ok(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(task))));
  assert.ok(lastInput);
  await assert.rejects(lastInput.handle.stat());
  // Joining the interrupted request closes its HTTP connection; the fixture callback records it.
  await blockedClosed;
  assert.equal(cancelled, true);
  checks.push("Provider cancellation interrupts a pending API request and closes its scoped file handles");
  passed = true;
} finally {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ passed, checks, requestCount, cancelled }, null, 2)}\n`);
  http.closeAllConnections();
  await new Promise<void>((done) => http.close(() => done()));
  gateway.dispose();
  conversation.dispose();
  database.close();
  await rm(root, { recursive: true, force: true });
}
logger.info("API channel tool file and delivery checks passed.");
