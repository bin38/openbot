// Drives the real cloud-download service, attachment gateway, SQLite commit, and managed files.
// Only the external E2B adapter is replaced by a bounded local stream. No cloud account is used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Fiber } from "effect";
import { AttachmentGateway } from "../src/backend/agent/attachment-gateway";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { responseAttachmentMessageId } from "../src/backend/agent/delivery-content";
import { withE2bRequestCancellation } from "../src/backend/agent/e2b-request";
import type { OpenBotToolResponse } from "../src/backend/agent/routine-tools";
import { AgentStore } from "../src/backend/agent-store";
import { attachmentFailure } from "../src/backend/attachment-effects";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { sha256File } from "../src/backend/file-hash";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import type { E2bDesktopAdapterPort } from "../src/main/e2b-desktop-adapter";
import { e2bFailure } from "../src/main/e2b-desktop-errors";
import { E2bDesktopService } from "../src/main/e2b-desktop-service";
import { E2bDesktopStore } from "../src/main/e2b-desktop-store";

const logger = createOpenBotLogger("e2b-download-attachment-e2e");
const reportPath = join(
  dirname(dirname(import.meta.filename)),
  ".openbot-build/e2b-download-attachment-e2e/report.json",
);
const root = await mkdtemp(join(tmpdir(), "openbot-cloud-attachment-"));
const userData = join(root, "data");
const privateDownloads = join(userData, "e2b-downloads");
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, join(root, "home"), database);
const mailbox = new MailboxStore(userData, store.sharedRoot, database);
const conversation = new ConversationRuntime(
  store,
  () => {},
  () => store.list(),
);
const events: AgentEvent[] = [];
const gateway = new AttachmentGateway({
  conversation,
  mailbox,
  sharedRoot: store.sharedRoot,
  hooks: { emit: (event) => events.push(event), emitError: () => {} },
});
const cloudStore = new E2bDesktopStore(join(userData, "e2b.json"), {
  // Test-only cipher. The separate E2B service check covers encryption and secret redaction.
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => value.toString(),
});
let downloads = 0;
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const blocked = { entered: barrier(), release: barrier(), cancelled: false };
const files = new Map<string, string>();
const unsupported = () => Effect.fail(e2bFailure("unavailable"));
const adapter: E2bDesktopAdapterPort = {
  create: () => Effect.succeed("fixture-machine"),
  connect: () => Effect.void,
  touch: () => Effect.void,
  info: () => Effect.succeed("running"),
  pause: () => Effect.void,
  delete: () => Effect.void,
  screenshot: unsupported,
  execute: unsupported,
  input: unsupported,
  upload: unsupported,
  startStream: unsupported,
  stopStream: () => Effect.void,
  dispose: () => Effect.void,
  download: (_machine, path) =>
    Effect.tryPromise({
      try: async () => {
        downloads += 1;
        if (path === "/broken")
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("Injected download failure"));
            },
          });
        if (path === "/blocked") {
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new Uint8Array(64 * 1024));
                return;
              }
              blocked.entered.release();
              return blocked.release.promise;
            },
            cancel() {
              blocked.cancelled = true;
              blocked.release.release();
            },
          });
        }
        const source = files.get(path);
        assert.ok(source, "The fixture must name a known cloud file.");
        const handle = await open(source, "r");
        let offset = 0;
        let closed = false;
        const close = async () => {
          if (!closed) {
            closed = true;
            await handle.close();
          }
        };
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const buffer = Buffer.allocUnsafe(64 * 1024);
              const read = await handle.read(buffer, 0, buffer.length, offset);
              if (read.bytesRead === 0) {
                await close();
                controller.close();
                return;
              }
              offset += read.bytesRead;
              controller.enqueue(buffer.subarray(0, read.bytesRead));
            } catch (error) {
              await close();
              controller.error(error);
            }
          },
          cancel: close,
        });
      },
      catch: () => e2bFailure("unavailable"),
    }),
};
const cloud = new E2bDesktopService({
  store: cloudStore,
  adapter,
  downloadDirectory: privateDownloads,
  agentExists: (id) => store.list().some((agent) => agent.id === id),
  workspaceForAgent: (id) => store.list().find((agent) => agent.id === id)?.workspacePath ?? null,
});
const checks: string[] = [];

function attached(response: OpenBotToolResponse) {
  assert.equal(response.success, true);
  const content = response.contentItems[0];
  assert.ok(content);
  const value = JSON.parse(content.text);
  assert.ok(isDynamicRecord(value) && value.status === "attached" && typeof value.messageId === "string");
  assert.ok(Array.isArray(value.attachments) && value.attachments.length === 1);
  const file = value.attachments[0];
  assert.ok(isDynamicRecord(file) && typeof file.id === "string" && typeof file.name === "string");
  assert.equal(content.text.includes(privateDownloads), false, "The model result must not expose private paths.");
  return { messageId: value.messageId, id: file.id, name: file.name };
}

async function assertPrivateFilesRemoved() {
  for (const owner of await readdir(privateDownloads)) {
    assert.deepEqual(await readdir(join(privateDownloads, owner)), [], "A private staging directory survived.");
  }
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  await Effect.runPromise(cloudStore.load());
  await Effect.runPromise(cloud.saveSettings({ apiKey: "fixture-cloud-key", template: "desktop", timeoutMinutes: 15 }));
  const agent = await runCauseEffect(
    store.createAgent({ name: "Cloud files", description: "Fixture", avatarSeed: "cloud-files", avatarHue: null }),
  );
  // A provider tool carries its provider thread ID. The public thread must first be owned by
  // this agent, just as the real runtime establishes it before starting a provider turn.
  const publicThreadId = store.ensureThreadIdNow(agent.id);
  await Effect.runPromise(cloud.start(agent.id));
  const large = join(root, "large.7z");
  const writer = await open(large, "wx");
  const bytes = 101 * 1024 * 1024 + 17;
  await writer.truncate(bytes);
  await writer.write(Buffer.from("cloud archive stays opaque"), 0, 26, 0);
  await writer.close();
  files.set("/large.7z", large);
  const small = join(root, "small.bin");
  await writeFile(small, new Uint8Array([0, 255, 31, 7]));
  files.set("/small.bin", small);
  const params = { threadId: "cloud-files-thread", turnId: "cloud-files-turn", callId: "cloud-files-call" };
  const messageId = responseAttachmentMessageId(params.threadId, params.turnId, params.callId);
  const deliver = (callId: string, remotePath: string, name: string) => {
    const request = { ...params, callId };
    return gateway.attachProducedFile(
      agent.id,
      request,
      responseAttachmentMessageId(request.threadId, request.turnId, request.callId),
      (consume) => cloud.download(agent.id, remotePath, name, consume).pipe(Effect.mapError(attachmentFailure)),
    );
  };

  const [first, concurrent] = await Promise.all([
    runCauseEffect(deliver(params.callId, "/large.7z", "result.7z")),
    runCauseEffect(deliver(params.callId, "/large.7z", "result.7z")),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(downloads, 1, "Concurrent duplicate tool calls must share one cloud download.");
  const result = attached(first);
  assert.equal(result.name, "result.7z");
  assert.equal(result.messageId, messageId);
  const managed = await runCauseEffect(mailbox.resolveAttachment(result.id));
  assert.ok(managed);
  assert.equal(await runCauseEffect(sha256File(managed.path)), await runCauseEffect(sha256File(large)));
  const saved = database
    .readConversation(agent.id, publicThreadId)
    .messages.find((message) => message.id === messageId);
  assert.ok(saved?.attachments?.[0]);
  assert.equal(saved.itemType, "agent_attachment");
  assert.equal(saved.attachments[0].size, bytes);
  assert.equal(saved.attachments[0].previewKind, "none");
  assert.equal(saved.attachments[0].mimeType, "application/octet-stream");
  assert.equal(events.filter((event) => event.type === "conversation").length, 1);
  await assertPrivateFilesRemoved();
  checks.push(
    "101 MiB cloud file becomes a durable opaque chat attachment; concurrent retry downloads and commits once",
  );

  attached(await runCauseEffect(deliver(params.callId, "/large.7z", "result.7z")));
  assert.equal(downloads, 1);
  const reopenedConversation = new ConversationRuntime(
    store,
    () => {},
    () => store.list(),
  );
  const reopenedGateway = new AttachmentGateway({
    conversation: reopenedConversation,
    mailbox,
    sharedRoot: store.sharedRoot,
    hooks: { emit: () => {}, emitError: () => {} },
  });
  try {
    const reopened = await runCauseEffect(
      reopenedGateway.attachProducedFile(agent.id, params, messageId, () =>
        Effect.fail(attachmentFailure(new Error("A committed result must not download again."))),
      ),
    );
    assert.deepEqual(attached(reopened), result);
  } finally {
    reopenedGateway.dispose();
    reopenedConversation.dispose();
  }
  checks.push("sequential retry and a new conversation runtime recover the committed attachment without downloading");

  const generationRoot = join(store.sharedRoot, "Transfers", "generated");
  const beforeFiles = (await readdir(generationRoot)).sort();
  const commit = mailbox.persistGeneratedAttachmentsWithConversation.bind(mailbox);
  mailbox.persistGeneratedAttachmentsWithConversation = () => {
    throw new Error("Injected commit failure");
  };
  try {
    await assert.rejects(runCauseEffect(deliver("commit-failure", "/small.bin", "failed.bin")));
  } finally {
    mailbox.persistGeneratedAttachmentsWithConversation = commit;
  }
  assert.deepEqual((await readdir(generationRoot)).sort(), beforeFiles);
  assert.equal(
    database
      .readConversation(agent.id, publicThreadId)
      .messages.some(
        (message) => message.id === responseAttachmentMessageId(params.threadId, params.turnId, "commit-failure"),
      ),
    false,
  );
  await assertPrivateFilesRemoved();
  assert.ok(
    await runCauseEffect(mailbox.resolveAttachment(result.id)),
    "Cleanup must not remove an earlier committed attachment.",
  );
  attached(await runCauseEffect(deliver("commit-failure", "/small.bin", "retry.bin")));
  checks.push("failed commit removes staged and private files, retains previous attachments, and permits retry");

  await assert.rejects(runCauseEffect(deliver("stream-failure", "/broken", "broken.bin")));
  await assertPrivateFilesRemoved();
  await assert.rejects(
    runCauseEffect(
      gateway.attachFiles(
        agent.id,
        { ...params, callId: "private-path" },
        [large],
        responseAttachmentMessageId(params.threadId, params.turnId, "private-path"),
      ),
    ),
  );
  checks.push("interrupted cloud stream cleans private files; the ordinary path attachment policy is unchanged");

  const beforeStop = (await readdir(generationRoot)).sort();
  const downloadCountBeforeStop = downloads;
  const stop = new AbortController();
  const producer = Effect.runFork(
    withE2bRequestCancellation(deliver("user-stop", "/blocked", "cancelled.bin"), stop.signal),
  );
  await blocked.entered.promise;
  const waiter = Effect.runFork(deliver("user-stop", "/blocked", "cancelled.bin"));
  await Effect.runPromise(Fiber.interrupt(waiter));
  assert.equal(gateway.pendingCommands().length, 1, "Stopping a duplicate waiter must retain the producer.");
  assert.equal(downloads, downloadCountBeforeStop + 1);
  assert.equal(blocked.cancelled, false, "Stopping a waiter must not cancel the active cloud stream.");
  stop.abort();
  const stopped = await Effect.runPromise(Fiber.await(producer));
  assert.equal(Exit.hasInterrupts(stopped), true, "Provider Stop must interrupt the request effect.");
  assert.equal(blocked.cancelled, true, "Stopping the producer must cancel a blocked cloud stream.");
  assert.equal(gateway.pendingCommands().length, 0, "A stopped producer must release its dedup entry.");
  await assertPrivateFilesRemoved();
  assert.deepEqual((await readdir(generationRoot)).sort(), beforeStop);
  attached(await runCauseEffect(deliver("user-stop", "/small.bin", "resumed.bin")));
  assert.equal(downloads, downloadCountBeforeStop + 2, "The same tool call can retry after interruption.");
  checks.push(
    "Provider AbortSignal Stop cancels a blocked download and cleans files; a stopped duplicate waiter cannot cancel it; the same call can retry",
  );

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ passed: true, liveCloudVerified: false, checks }, null, 2)}\n`);
  logger.info("Cloud download attachment checks passed.");
} finally {
  await Effect.runPromise(cloud.dispose()).catch(() => undefined);
  gateway.dispose();
  conversation.dispose();
  database.close();
  await rm(root, { recursive: true, force: true });
}
