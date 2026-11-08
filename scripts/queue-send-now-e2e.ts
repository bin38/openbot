// Drives the real queue service and SQLite; provider interruption is captured without starting a model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InterruptTurnInput, QueueSnapshot, ReorderQueueInput } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { stopAndSendQueuedMessage } from "../src/renderer/src/features/conversation/send-queued-message-now";

const logger = createOpenBotLogger("queue-send-now-e2e");
const output = resolve(".openbot-build/queue-send-now-e2e");
const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-send-now-")));
const checks: string[] = [];
let passed = false;
const unused = () => Effect.die(new Error("No browser or provider is used by this fixture."));
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

interface Fixture {
  scope: string;
  agentId: string;
  database: OpenBotDatabase;
  store: AgentStore;
  mailbox: MailboxStore;
  service: AgentService;
}
const fixtures: Fixture[] = [];
async function fixture(scope: string, agentId?: string): Promise<Fixture> {
  const data = join(root, scope, "data");
  const home = join(root, scope, "home");
  await mkdir(home, { recursive: true });
  const database = new OpenBotDatabase(data);
  const store = new AgentStore(data, home, database);
  await runCauseEffect(store.initialize());
  const agent = agentId
    ? await runCauseEffect(store.getOrCreate(agentId, "Queue fixture"))
    : await runCauseEffect(
        store.createAgent({ name: "Queue fixture", description: "", avatarSeed: "queue-fixture", avatarHue: null }),
      );
  const mailbox = new MailboxStore(data, store.sharedRoot, database);
  await runCauseEffect(mailbox.initialize());
  const service = new AgentService({ store, mailbox, browser });
  const value = { scope, agentId: agent.id, database, store, mailbox, service };
  fixtures.push(value);
  return value;
}
async function enqueue(host: Fixture, text: string): Promise<string> {
  const receipt = await runCauseEffect(
    host.mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [host.agentId], text }),
  );
  const delivery = receipt.deliveries[0];
  assert.ok(delivery);
  return delivery.id;
}
function queued(host: Fixture): string[] {
  return host.service
    .listQueue(host.agentId)
    .deliveries.filter((delivery) => delivery.status === "queued")
    .map((delivery) => delivery.id);
}
function operation(
  host: Fixture,
  deliveryId: string,
  hooks: {
    beforeReorder?: () => Promise<void> | void;
    afterReorder?: () => Promise<void> | void;
  } = {},
) {
  let currentScope = host.scope;
  let disposed = false;
  let activeTurn: string | null = "captured-turn";
  const calls: {
    reads: string[];
    reorders: { input: ReorderQueueInput; scope: string }[];
    interrupts: { input: InterruptTurnInput; scope: string }[];
    errors: string[];
  } = { reads: [], reorders: [], interrupts: [], errors: [] };
  return {
    calls,
    switchScope: (scope: string) => {
      currentScope = scope;
      if (scope !== host.scope) disposed = true;
    },
    switchTurn: (turn: string | null) => {
      activeTurn = turn;
    },
    run: () =>
      stopAndSendQueuedMessage({
        agentId: host.agentId,
        deliveryId,
        turnId: "captured-turn",
        serverId: host.scope,
        current: () => !disposed && currentScope === host.scope,
        activeTurnId: () => activeTurn,
        readQueue: async (agent, scope): Promise<QueueSnapshot> => {
          calls.reads.push(scope);
          assert.equal(scope, host.scope);
          assert.equal(agent, host.agentId);
          return host.service.listQueue(agent);
        },
        reorder: async (input, scope) => {
          calls.reorders.push({ input, scope });
          assert.equal(scope, host.scope);
          await hooks.beforeReorder?.();
          await runCauseEffect(host.service.reorderQueue(input));
          await hooks.afterReorder?.();
        },
        interrupt: async (input, scope) => {
          calls.interrupts.push({ input, scope });
        },
        onFailure: (_error, stage) => {
          calls.errors.push(stage);
        },
      }),
  };
}

try {
  const normal = await fixture("normal");
  const first = await enqueue(normal, "First");
  const selected = await enqueue(normal, "Selected");
  const channels = new ChannelStore(normal.database);
  const channel = channels.create(randomUUID(), {
    name: "Reserved",
    title: "",
    instructions: "",
    members: [{ agentId: normal.agentId }],
    leadAgentId: normal.agentId,
  });
  channels.commit(randomUUID(), { channel, messages: [], tasks: [], assignments: [] });
  await runCauseEffect(
    normal.mailbox.enqueue({
      sender: { kind: "user" },
      recipientAgentIds: [normal.agentId],
      channelId: channel.id,
      text: "Reserved channel work",
    }),
  );
  await runCauseEffect(
    normal.mailbox.enqueue({
      sender: { kind: "user" },
      recipientAgentIds: [normal.agentId],
      messaging: {
        linkId: randomUUID(),
        authorId: "fixture-author",
        authorName: "Fixture",
        platformMessageId: randomUUID(),
      },
      text: "Reserved messaging work",
    }),
  );
  const reservations = normal.mailbox.queuedExecutionDeliveryIds(normal.agentId);
  const success = operation(normal, selected);
  assert.equal(await success.run(), true);
  assert.deepEqual(queued(normal), [selected, first]);
  assert.deepEqual(normal.mailbox.queuedExecutionDeliveryIds(normal.agentId), reservations);
  assert.deepEqual(
    reservations.map((id) => normal.mailbox.getDelivery(id)?.delivery.position),
    [1, 2],
  );
  assert.equal(normal.mailbox.getDelivery(selected)?.delivery.position, reservations.length + 1);
  assert.deepEqual(success.calls.interrupts, [
    { input: { agentId: normal.agentId, turnId: "captured-turn" }, scope: normal.scope },
  ]);
  assert.ok(success.calls.reads.every((scope) => scope === normal.scope));
  checks.push(
    "Real queue reorder puts the selected message first, preserves reserved channel/messaging work and targets only the captured server/turn.",
  );

  const edited = await fixture("edited");
  const editedHead = await enqueue(edited, "Edited head");
  const editedNext = await enqueue(edited, "Waiting");
  const editId = randomUUID();
  edited.mailbox.beginQueueEdit(edited.agentId, editedHead, editId);
  const held = operation(edited, editedNext);
  assert.equal(await held.run(), false);
  assert.equal(held.calls.reorders.length, 0);
  assert.equal(held.calls.interrupts.length, 0);
  edited.mailbox.finishQueueEdit(edited.agentId, editedHead, editId);
  const lateEditId = randomUUID();
  const editingDuringReorder = operation(edited, editedNext, {
    afterReorder: () => {
      edited.mailbox.beginQueueEdit(edited.agentId, editedNext, lateEditId);
    },
  });
  assert.equal(await editingDuringReorder.run(), false);
  assert.equal(editingDuringReorder.calls.interrupts.length, 0);
  edited.mailbox.finishQueueEdit(edited.agentId, editedNext, lateEditId);
  checks.push("An edited head, including an edit that starts during reorder, stops no running turn.");

  const stale = await fixture("stale");
  await enqueue(stale, "Head");
  const staleSelected = await enqueue(stale, "Selected");
  const failed = operation(stale, staleSelected, {
    beforeReorder: async () => {
      await enqueue(stale, "Concurrent new message");
    },
  });
  assert.equal(await failed.run(), false);
  assert.deepEqual(failed.calls.errors, ["reorder"]);
  assert.equal(failed.calls.interrupts.length, 0);
  checks.push("A real stale-order rejection reports reorder failure and interrupts nothing.");

  const changed = await fixture("turn-change");
  await enqueue(changed, "Head");
  const changedSelected = await enqueue(changed, "Selected");
  const nextTurn = operation(changed, changedSelected, {
    afterReorder: () => {
      nextTurn.switchTurn("newer-turn");
    },
  });
  assert.equal(await nextTurn.run(), false);
  assert.equal(nextTurn.calls.interrupts.length, 0);
  checks.push("A newer turn that starts during reorder is never interrupted.");

  const switched = await fixture("server-a");
  await enqueue(switched, "Head");
  const switchedSelected = await enqueue(switched, "Selected");
  const other = await fixture("server-b", switched.agentId);
  const otherHead = await enqueue(other, "Other server head");
  const switchServer = operation(switched, switchedSelected, {
    afterReorder: () => {
      switchServer.switchScope(other.scope);
    },
  });
  assert.equal(await switchServer.run(), false);
  assert.equal(switchServer.calls.interrupts.length, 0);
  assert.ok(switchServer.calls.reorders.every((call) => call.scope === switched.scope));
  assert.deepEqual(queued(other), [otherHead]);
  checks.push(
    "A server switch during an asynchronous reorder cannot stop a turn or reorder data on the newly selected host.",
  );

  const returned = await fixture("returned-scope");
  await enqueue(returned, "Head");
  const returnedSelected = await enqueue(returned, "Selected");
  const roundTrip = operation(returned, returnedSelected, {
    afterReorder: () => {
      roundTrip.switchScope(other.scope);
      roundTrip.switchScope(returned.scope);
    },
  });
  assert.equal(await roundTrip.run(), false);
  assert.equal(roundTrip.calls.interrupts.length, 0);
  checks.push("Leaving and returning to the same server does not revive a disposed action's permission to interrupt.");

  const cancelled = await fixture("cancelled");
  await enqueue(cancelled, "Head");
  const cancelledSelected = await enqueue(cancelled, "Selected");
  const cancellation = operation(cancelled, cancelledSelected, {
    afterReorder: () => runCauseEffect(cancelled.mailbox.cancel(cancelled.agentId, cancelledSelected)),
  });
  assert.equal(await cancellation.run(), false);
  assert.equal(cancellation.calls.interrupts.length, 0);
  checks.push("A message cancelled on another device during reorder does not cause an empty stop.");
  passed = true;
} finally {
  for (const host of fixtures) {
    await runCauseEffect(host.service.stop()).catch(() => undefined);
    host.database.close();
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, liveProviderUsed: false }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
  logger.info("Queue Send-now checks finished.", { passed, checks: checks.length });
}
