import type { CustomProviderModelSyncState, CustomProviderSummary, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

export function createMockCustomProviderModelSync(
  providers: () => readonly CustomProviderSummary[],
): OpenBotDesktopApi["customProviderModelSync"] {
  const saved = new Map<string, CustomProviderModelSyncState>();
  const listeners = new Set<(states: CustomProviderModelSyncState[]) => void>();
  const list = () =>
    providers().map((provider) => ({
      ...(saved.get(provider.id) ?? {
        id: provider.id,
        enabled: false,
        running: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailure: null,
        lastRestart: null,
        upstreamCount: null,
        missingModelIds: [],
        omittedModelCount: 0,
      }),
    }));
  const notify = () => {
    for (const listener of listeners) listener(structuredClone(list()));
  };
  const stateFor = (id: string) => {
    const state = list().find((item) => item.id === id);
    if (!state) throw new Error(sourceText("error.provider.endpointNotSaved"));
    return state;
  };
  const refresh = (id: string) => {
    const state = stateFor(id);
    const at = new Date().toISOString();
    saved.set(id, {
      ...state,
      lastAttemptAt: at,
      lastSuccessAt: at,
      upstreamCount: providers().find((item) => item.id === id)?.models.length ?? 0,
    });
    notify();
    return structuredClone(list());
  };
  return {
    list: async () => structuredClone(list()),
    refresh: async ({ id }) => refresh(id),
    setEnabled: async ({ id, enabled }) => {
      saved.set(id, { ...stateFor(id), enabled });
      if (enabled) return refresh(id);
      notify();
      return structuredClone(list());
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
