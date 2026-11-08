import { type GeminiProxySettings, isGeminiProxySettings, normalizeGeminiProxyUrl } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentLifecycleFailed } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { GeminiProxySettingsStore } from "../gemini-proxy-settings-store";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export function parseGeminiProxySettings(value: unknown): GeminiProxySettings {
  if (!isGeminiProxySettings(value)) throw new Error(sourceText("error.provider.geminiProxyUrl"));
  const proxyUrl = normalizeGeminiProxyUrl(value.proxyUrl);
  if (!proxyUrl) throw new Error(sourceText("error.provider.geminiProxyUrl"));
  return { enabled: value.enabled, proxyUrl };
}

export function geminiProxyIpcHandlers(dependencies: {
  settings: Pick<GeminiProxySettingsStore, "get" | "set">;
  restartGemini: () => Effect.Effect<void, AgentLifecycleFailed>;
}): Pick<IpcGroupHandlers, "geminiProxy"> {
  const { settings, restartGemini } = dependencies;
  return {
    geminiProxy: {
      getSettings: handler(() => settings.get()),
      setSettings: payloadHandler(parseGeminiProxySettings, (next) =>
        runCauseEffect(
          Effect.gen(function* () {
            const previous = settings.get();
            const saved = yield* settings.set(next);
            if (previous.enabled !== saved.enabled || (saved.enabled && previous.proxyUrl !== saved.proxyUrl))
              yield* restartGemini();
            return saved;
          }),
        ),
      ),
    },
  };
}
