import type { InterruptTurnInput, QueueSnapshot, ReorderQueueInput } from "@openbot/contracts/ipc";
import { queuedDeliveriesInOrder } from "../../queue-reconciliation";

export interface SendQueuedMessageNowOptions {
  agentId: string;
  deliveryId: string;
  turnId: string;
  serverId: string;
  current: () => boolean;
  activeTurnId: () => string | null | undefined;
  readQueue: (agentId: string, serverId: string) => Promise<QueueSnapshot>;
  reorder: (input: ReorderQueueInput, serverId: string) => Promise<void>;
  interrupt: (input: InterruptTurnInput, serverId: string) => Promise<void>;
  onFailure: (error: unknown, stage: "reorder" | "interrupt") => void;
}

/** Stops only the captured turn, after the chosen normal message has a runnable queue position. */
export async function stopAndSendQueuedMessage(options: SendQueuedMessageNowOptions): Promise<boolean> {
  const current = () => options.current() && options.activeTurnId() === options.turnId;
  if (!current()) return false;
  let stage: "reorder" | "interrupt" = "reorder";
  try {
    const initial = await options.readQueue(options.agentId, options.serverId);
    if (!current() || initial.agentId !== options.agentId) return false;
    const queued = queuedDeliveriesInOrder(initial);
    const selected = queued.find((delivery) => delivery.id === options.deliveryId);
    if (!selected || selected.editing || queued[0]?.editing) return false;
    if (queued[0]?.id !== options.deliveryId) {
      // The host puts channel, messaging and task work before these visible queue ids.
      await options.reorder(
        {
          agentId: options.agentId,
          deliveryIds: [
            options.deliveryId,
            ...queued.filter((delivery) => delivery.id !== options.deliveryId).map((delivery) => delivery.id),
          ],
        },
        options.serverId,
      );
    }
    if (!current()) return false;
    // Another editor or device can change the queue while the reorder is in flight.
    const latest = await options.readQueue(options.agentId, options.serverId);
    if (!current() || latest.agentId !== options.agentId) return false;
    const waiting = queuedDeliveriesInOrder(latest);
    const next = waiting.find((delivery) => delivery.id === options.deliveryId);
    if (!next || next.editing || waiting[0]?.editing || waiting[0]?.id !== options.deliveryId) return false;
    stage = "interrupt";
    await options.interrupt({ agentId: options.agentId, turnId: options.turnId }, options.serverId);
    return true;
  } catch (error) {
    if (current()) options.onFailure(error, stage);
    return false;
  }
}
