import type { E2bViewerBounds } from "@openbot/contracts/ipc";
import { Effect, Result } from "effect";
import type { IpcMainInvokeEvent } from "electron";
import { type E2bFailure, e2bFailure } from "../e2b-desktop-errors";
import type { E2bDesktopService } from "../e2b-desktop-service";
import { requireE2bViewerSender } from "../e2b-viewer-policy";
import type { E2bViewerRequest } from "../main-window";
import { authorizedHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
  decodeE2bAgentInput,
  decodeE2bSettingsInput,
  decodeE2bTakeoverInput,
  decodeE2bViewerBoundsInput,
} from "./e2b-inputs";

export interface E2bIpcDependencies {
  e2b: E2bDesktopService;
  openViewer: (input: E2bViewerRequest) => Promise<void> | void;
  /** Programmatic closure must not call onClosed again. */
  closeViewer: (agentId: string) => void;
  mainRendererId: () => number | null;
  hasEmbeddedViewer: (agentId: string) => boolean;
  setViewerBounds: (agentId: string, bounds: E2bViewerBounds | null) => void;
}

async function runE2b<A>(operation: Effect.Effect<A, E2bFailure>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

/** Only the trusted local settings surface reaches this group; no key or viewer URL is returned. */
export function e2bIpcHandlers({
  e2b,
  openViewer,
  closeViewer,
  mainRendererId,
  hasEmbeddedViewer,
  setViewerBounds,
}: E2bIpcDependencies): Pick<IpcGroupHandlers, "e2b"> {
  const fromMain = (event: IpcMainInvokeEvent) => requireE2bViewerSender(event.sender.id, mainRendererId());
  // The cloud lock protects the machine. This queue also covers the window opened after a
  // takeover returns, so closing a pane during that request cannot leave an orphan viewer.
  const pending = new Map<string, Promise<void>>();
  const revisions = new Map<string, number>();
  const embedded = new Set<string>();
  const advance = (agentId: string) => {
    const revision = (revisions.get(agentId) ?? 0) + 1;
    revisions.set(agentId, revision);
    return revision;
  };
  function sequence<A>(agentId: string, operation: () => Promise<A>): Promise<A> {
    const result = (pending.get(agentId) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(agentId, settled);
    void settled.then(() => {
      if (pending.get(agentId) === settled) pending.delete(agentId);
    });
    return result;
  }
  const endViewer = (agentId: string) => {
    advance(agentId);
    embedded.delete(agentId);
    closeViewer(agentId);
  };
  return {
    e2b: {
      getSettings: handler(() => e2b.getSettings()),
      saveSettings: payloadHandler(decodeE2bSettingsInput, (input) => runE2b(e2b.saveSettings(input))),
      list: handler(() => e2b.list()),
      status: payloadHandler(decodeE2bAgentInput, ({ agentId }) => runE2b(e2b.status(agentId))),
      start: payloadHandler(decodeE2bAgentInput, ({ agentId }) => runE2b(e2b.start(agentId))),
      pause: payloadHandler(decodeE2bAgentInput, async ({ agentId }) => {
        endViewer(agentId);
        return sequence(agentId, () => runE2b(e2b.pause(agentId)));
      }),
      delete: payloadHandler(decodeE2bAgentInput, async ({ agentId }) => {
        endViewer(agentId);
        await sequence(agentId, () => runE2b(e2b.delete(agentId)));
      }),
      takeover: authorizedHandler(fromMain, decodeE2bTakeoverInput, (_event, { agentId, bounds }) => {
        const revision = advance(agentId);
        if (bounds) embedded.add(agentId);
        else embedded.delete(agentId);
        return sequence(agentId, async () => {
          if (revisions.get(agentId) !== revision) {
            const current = await runE2b(e2b.status(agentId));
            if (!current) throw e2bFailure("machineMissing");
            return current;
          }
          const { machine, ...viewer } = await runE2b(e2b.takeover(agentId));
          if (revisions.get(agentId) !== revision) return machine;
          try {
            await openViewer({
              agentId,
              ...viewer,
              ...(bounds ? { bounds } : {}),
              onClosed: async () => {
                if (revisions.get(agentId) !== revision) return;
                advance(agentId);
                embedded.delete(agentId);
                await sequence(agentId, () => runE2b(e2b.handback(agentId)));
              },
            });
          } catch {
            // A failed revoke deliberately leaves the durable human lease in place.
            await runE2b(e2b.handback(agentId));
            throw e2bFailure("viewerFailed");
          }
          return machine;
        });
      }),
      setViewerBounds: authorizedHandler(fromMain, decodeE2bViewerBoundsInput, (_event, { agentId, bounds }) => {
        setViewerBounds(agentId, bounds);
      }),
      closeViewer: authorizedHandler(fromMain, decodeE2bAgentInput, async (_event, { agentId }) => {
        if (!embedded.has(agentId) && !hasEmbeddedViewer(agentId)) return;
        endViewer(agentId);
        await sequence(agentId, () => runE2b(e2b.handback(agentId)));
      }),
      handback: payloadHandler(decodeE2bAgentInput, async ({ agentId }) => {
        endViewer(agentId);
        return sequence(agentId, () => runE2b(e2b.handback(agentId)));
      }),
      screenshot: payloadHandler(decodeE2bAgentInput, ({ agentId }) => runE2b(e2b.screenshot(agentId))),
      preview: payloadHandler(decodeE2bAgentInput, ({ agentId }) => runE2b(e2b.screenshot(agentId, "agent"))),
    },
  };
}
