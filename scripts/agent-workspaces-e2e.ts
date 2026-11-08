// Real roster, SQLite and filesystem checks. No provider or user directory is opened.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { resolveWorkspaceFile } from "../src/backend/workspace-paths";

const logger = createOpenBotLogger("agent-workspaces-e2e");
const output = resolve(".openbot-build/agent-workspaces-e2e");
const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-workspaces-")));
const userData = join(root, "profile");
const home = join(root, "home");
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
let database: OpenBotDatabase | null = null;
let service: AgentService | null = null;
const checks: string[] = [];
let passed = false;
const unused = () => Effect.die(new Error("No browser operation is used by this fixture."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
try {
  await mkdir(home, { recursive: true });
  await mkdir(projectA);
  await mkdir(projectB);
  await writeFile(join(projectA, "project.txt"), "external-project-a");
  await writeFile(join(projectB, "project.txt"), "external-project-b");
  database = new OpenBotDatabase(userData);
  let store = new AgentStore(userData, home, database);
  await runCauseEffect(store.initialize());
  const create = (name: string) =>
    runCauseEffect(
      store.createAgent({ name, description: "Workspace fixture", avatarSeed: name.toLowerCase(), avatarHue: null }),
    );
  const first = await create("First");
  const second = await create("Second");
  assert.notEqual(first.workspacePath, second.workspacePath);
  await writeFile(join(first.workspacePath, "retained.txt"), "managed-file");
  await writeFile(join(second.workspacePath, "separate.txt"), "second-file");
  const threadId = store.ensureThreadIdNow(first.id);
  const messageId = randomUUID();
  database.appendConversationMessage({
    agentId: first.id,
    threadId,
    activeTurnId: null,
    message: {
      id: messageId,
      author: "user",
      text: "Retained history",
      createdAt: new Date().toISOString(),
      status: "completed",
    },
    eventType: "fixture.message",
  });
  const selected = await runCauseEffect(store.setWorkspace(first.id, projectA));
  assert.equal(selected.id, first.id);
  assert.equal(selected.threadId, threadId);
  assert.equal(selected.workspacePath, projectA);
  assert.equal("workspaceBinding" in selected, false);
  assert.equal(await readFile(join(first.workspacePath, "retained.txt"), "utf8"), "managed-file");
  assert.equal(await readFile(join(projectA, "project.txt"), "utf8"), "external-project-a");
  assert.equal(
    database.readConversation(first.id, threadId).messages.some((message) => message.id === messageId),
    true,
  );
  const retained = await runCauseEffect(
    resolveWorkspaceFile(selected, join(first.workspacePath, "retained.txt"), { allowOutside: true }),
  );
  assert.equal(retained.path, join(first.workspacePath, "retained.txt"));
  checks.push(
    "A chosen project becomes the workspace without moving files, public identity, history or old local file links.",
  );

  await runCauseEffect(store.setWorkspace(second.id, projectA));
  assert.equal((await runCauseEffect(store.workspaceInfo(second.id))).path, projectA);
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).path, projectA);
  await runCauseEffect(store.setWorkspace(second.id, null));
  const nested = join(projectA, "nested");
  await mkdir(nested);
  await assert.rejects(runCauseEffect(store.setWorkspace(second.id, nested)), /overlapping workspace/u);
  await assert.rejects(runCauseEffect(store.setWorkspace(second.id, root)), /managed, shared and application folders/u);
  await assert.rejects(
    runCauseEffect(
      store.setWorkspace(first.id, projectB, () => {
        throw new Error("fixture-busy");
      }),
    ),
    /fixture-busy/u,
  );
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).path, projectA);
  assert.equal(store.list().find((agent) => agent.id === second.id)?.workspacePath, second.workspacePath);
  checks.push(
    "Shared project selection is explicit; nested/reserved folders and a busy-before-commit guard preserve existing workspaces.",
  );

  await runCauseEffect(store.setWorkspace(second.id, projectB));
  const channelStore = new ChannelStore(database);
  const channel = channelStore.create(randomUUID(), {
    name: "Combined",
    title: "",
    instructions: "",
    leadAgentId: first.id,
    members: [{ agentId: first.id }, { agentId: second.id }],
  });
  channelStore.commit(randomUUID(), { channel, messages: [], tasks: [], assignments: [] });
  assert.deepEqual(
    channelStore.get(channel.id).members.map((member) => member.agentId),
    [first.id, second.id],
  );
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).path, projectA);
  assert.equal((await runCauseEffect(store.workspaceInfo(second.id))).path, projectB);
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).sharedPath, store.sharedRoot);
  checks.push(
    "A durable channel combines members while their project folders remain separate and a shared delivery folder stays available.",
  );

  database.close();
  database = new OpenBotDatabase(userData);
  store = new AgentStore(userData, home, database);
  await runCauseEffect(store.initialize());
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).path, projectA);
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).managedPath, first.workspacePath);
  assert.equal(store.list().find((agent) => agent.id === first.id)?.threadId, threadId);
  const projectC = join(root, "project-c");
  await mkdir(projectC);
  const mailbox = new MailboxStore(userData, store.sharedRoot, database);
  await runCauseEffect(mailbox.initialize());
  service = new AgentService({ store, mailbox, browser });
  const receipt = await runCauseEffect(
    mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [first.id], text: "Pending fixture delivery" }),
  );
  const delivery = receipt.deliveries[0];
  assert.ok(delivery);
  await assert.rejects(runCauseEffect(service.setAgentWorkspace(first.id, projectC)), /finishes its work/u);
  assert.equal((await runCauseEffect(service.getAgentWorkspace(first.id))).path, projectA);
  await runCauseEffect(mailbox.cancel(first.id, delivery.id));
  assert.equal((await runCauseEffect(service.setAgentWorkspace(first.id, projectC))).path, projectC);
  assert.equal(store.list().find((agent) => agent.id === first.id)?.threadId, threadId);
  await runCauseEffect(service.setAgentWorkspace(first.id, projectA));
  await runCauseEffect(service.stop());
  service = null;
  checks.push(
    "The real service refuses a queued agent, permits an idle change and keeps its public conversation identity.",
  );
  const profileId = randomUUID().replaceAll("-", "");
  await runCauseEffect(store.updateAgent({ agentId: first.id, browserProfileId: profileId }));
  const duplicate = await runCauseEffect(store.duplicateAgent(first.id));
  assert.notEqual(duplicate.workspacePath, projectA);
  assert.equal((await runCauseEffect(store.workspaceInfo(duplicate.id))).custom, false);
  assert.equal(await readFile(join(duplicate.workspacePath, "retained.txt"), "utf8"), "managed-file");
  await assert.rejects(access(join(duplicate.workspacePath, "project.txt")));
  assert.equal(duplicate.browserProfileId, profileId);
  assert.equal(duplicate.ownBrowserSession, true);
  await runCauseEffect(store.deleteAgent(duplicate.id));
  checks.push(
    "Restart keeps project bindings; duplicate agents get independent managed files and retain a named browser profile.",
  );

  const restored = await runCauseEffect(store.setWorkspace(first.id, null));
  assert.equal(restored.workspacePath, first.workspacePath);
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).custom, false);
  assert.equal(await readFile(join(projectA, "project.txt"), "utf8"), "external-project-a");
  await runCauseEffect(store.setWorkspace(first.id, projectA));
  await rm(projectA, { recursive: true });
  assert.equal((await runCauseEffect(store.workspaceInfo(first.id))).available, false);
  await assert.rejects(runCauseEffect(store.existing(first.id)), /workspace folder is unavailable/u);
  await assert.rejects(access(projectA));
  await mkdir(projectA);
  await writeFile(join(projectA, "project.txt"), "external-project-a");
  await runCauseEffect(store.deleteAgent(first.id));
  assert.equal(await readFile(join(projectA, "project.txt"), "utf8"), "external-project-a");
  assert.equal(await readFile(join(projectB, "project.txt"), "utf8"), "external-project-b");
  checks.push("Restore/delete never remove selected projects; a missing custom folder is not silently recreated.");
  passed = true;
} finally {
  if (service) await runCauseEffect(service.stop()).catch(() => undefined);
  database?.close();
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  logger.info("Agent workspace checks finished.", { passed, checks: checks.length });
}
