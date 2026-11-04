import type { CustomProviderModelSyncState, SetCustomProviderModelSyncInput } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Result, Schema, Scope, Semaphore } from "effect";
import type { CustomProviderChanges } from "./custom-provider-changes";
import type { CustomProviderStore } from "./custom-provider-store";

const SYNC_INTERVAL_MS = 60 * 60 * 1000;

export class CustomProviderModelSyncFailure extends Schema.TaggedError<CustomProviderModelSyncFailure>()(
  "CustomProviderModelSyncFailure",
  {
    message: Schema.String,
  },
) {}

interface Dependencies {
  store: Pick<CustomProviderStore, "modelSyncStates" | "setModelSync">;
  changes: Pick<CustomProviderChanges, "syncModels">;
  /** Internal service fixture setting; no renderer or saved configuration can change the cadence. */
  intervalMs?: number;
}

export type CustomProviderModelSync = Context.Service.Shape<typeof ModelSynchronization>;

class ModelSynchronization extends Context.Service<
  ModelSynchronization,
  {
    list(): CustomProviderModelSyncState[];
    refresh(id: string): Effect.Effect<CustomProviderModelSyncState[], CustomProviderModelSyncFailure>;
    setEnabled(
      input: SetCustomProviderModelSyncInput,
    ): Effect.Effect<CustomProviderModelSyncState[], CustomProviderModelSyncFailure>;
    subscribe(listener: (state: CustomProviderModelSyncState[]) => void): () => void;
  }
>()("openbot/main/CustomProviderModelSync") {
  static layer({ store, changes, intervalMs = SYNC_INTERVAL_MS }: Dependencies) {
    return Layer.effect(
      ModelSynchronization,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const gate = Semaphore.makeUnsafe(1);
        const running = new Set<string>();
        const listeners = new Set<(state: CustomProviderModelSyncState[]) => void>();
        const failure = () =>
          new CustomProviderModelSyncFailure({ message: sourceText("error.provider.modelSyncFailed") });
        const list = () => store.modelSyncStates().map((state) => ({ ...state, running: running.has(state.id) }));
        const notify = () => {
          for (const listener of listeners) listener(list());
        };
        const refresh = (id: string, onlyWhenEnabled = false) =>
          gate.withPermit(
            Effect.fn("CustomProviderModelSync.refresh")(function* () {
              if (onlyWhenEnabled && !store.modelSyncStates().some((state) => state.id === id && state.enabled))
                return list();
              const exists = store.modelSyncStates().some((state) => state.id === id);
              if (!exists) return yield* Effect.fail(failure());
              running.add(id);
              notify();
              return yield* Effect.gen(function* () {
                const attemptedAt = new Date().toISOString();
                yield* store.setModelSync(id, { lastAttemptAt: attemptedAt }).pipe(Effect.mapError(failure));
                const result = yield* Effect.result(changes.syncModels(id, onlyWhenEnabled));
                if (Result.isFailure(result)) {
                  // Only a fixed failure code leaves this operation. Remote responses and credentials
                  // are never retained in the state or delivered to the renderer.
                  yield* store.setModelSync(id, { lastFailure: "failed" }, attemptedAt).pipe(Effect.mapError(failure));
                } else if (result.success) {
                  yield* store
                    .setModelSync(
                      id,
                      {
                        lastSuccessAt: new Date().toISOString(),
                        lastFailure: null,
                        lastRestart: result.success.restart,
                        upstreamCount: result.success.upstreamCount,
                        missingModelIds: result.success.missingModelIds,
                        omittedModelCount: result.success.omittedModelCount,
                      },
                      attemptedAt,
                    )
                    .pipe(Effect.mapError(failure));
                }
                return list().map((state) => (state.id === id ? { ...state, running: false } : state));
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    running.delete(id);
                    notify();
                  }),
                ),
              );
            })(),
          );
        const setEnabled = Effect.fn("CustomProviderModelSync.setEnabled")(function* (
          input: SetCustomProviderModelSyncInput,
        ) {
          yield* gate.withPermit(
            store.setModelSync(input.id, { enabled: input.enabled }).pipe(Effect.mapError(failure)),
          );
          notify();
          return input.enabled ? yield* refresh(input.id) : list();
        });
        const poll = Effect.fn("CustomProviderModelSync.poll")(function* () {
          for (const state of store.modelSyncStates()) {
            if (!state.enabled) continue;
            const last = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
            if (Date.now() - last < intervalMs) continue;
            yield* refresh(state.id, true).pipe(Effect.catch(() => Effect.void));
          }
        });
        // One process-owned fiber. Startup checks due entries; each pass is followed by one hour.
        yield* Effect.forkIn(Effect.forever(poll().pipe(Effect.andThen(Effect.sleep(intervalMs)))), scope);
        yield* Effect.addFinalizer(() => Effect.sync(() => listeners.clear()));
        const owned = <A>(operation: Effect.Effect<A, CustomProviderModelSyncFailure>) =>
          operation.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.flatMap(Fiber.join));
        return ModelSynchronization.of({
          list,
          refresh: (id) => owned(refresh(id)),
          setEnabled: (input) => owned(setEnabled(input)),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        });
      }),
    );
  }
}

export const createCustomProviderModelSync = Effect.fn("CustomProviderModelSync.create")(function* (
  dependencies: Dependencies,
) {
  const runtime = ManagedRuntime.make(ModelSynchronization.layer(dependencies));
  const context = yield* runtime.contextEffect.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? runtime.disposeEffect : Effect.void)),
  );
  return { ...Context.get(context, ModelSynchronization), close: () => runtime.disposeEffect };
});
