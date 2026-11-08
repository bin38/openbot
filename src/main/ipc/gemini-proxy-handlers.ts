import {
  isSetGeminiProxySettingsInput,
  normalizeGeminiProxyUrl,
  type SetGeminiProxySettingsInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentLifecycleFailed } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { GeminiProxyBridgeFailure } from "../gemini-proxy-bridge";
import type { GeminiProxySettingsStore } from "../gemini-proxy-settings-store";
import { PreferenceFileFailure } from "../preference-file";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export function parseGeminiProxySettings(value: unknown): SetGeminiProxySettingsInput {
  if (!isSetGeminiProxySettingsInput(value)) {
    if (
      value &&
      typeof value === "object" &&
      "proxyUrl" in value &&
      typeof value.proxyUrl === "string" &&
      value.proxyUrl.startsWith("http")
    )
      throw new Error(sourceText("error.provider.geminiProxyUrl"));
    throw new Error(sourceText("error.provider.geminiProxyAddress"));
  }
  const proxyUrl = normalizeGeminiProxyUrl(value.proxyUrl);
  if (!proxyUrl) throw new Error(sourceText("error.provider.geminiProxyAddress"));
  return {
    enabled: value.enabled,
    proxyUrl,
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.password === undefined ? {} : { password: value.password }),
    ...(value.clearPassword === undefined ? {} : { clearPassword: value.clearPassword }),
  };
}

export function geminiProxyIpcHandlers(dependencies: {
  settings: Pick<GeminiProxySettingsStore, "get" | "set">;
  /** Refreshes main-only bridge credentials. No private value crosses IPC. */
  prepareProxy?: () => Effect.Effect<void, GeminiProxyBridgeFailure>;
  restartGemini: () => Effect.Effect<void, AgentLifecycleFailed>;
}): Pick<IpcGroupHandlers, "geminiProxy"> {
  const { settings, restartGemini, prepareProxy } = dependencies;
  return {
    geminiProxy: {
      getSettings: handler(() => settings.get()),
      setSettings: payloadHandler(parseGeminiProxySettings, (next) =>
        runCauseEffect(
          Effect.gen(function* () {
            const previous = settings.get();
            const saved = yield* settings.set(next);
            if (prepareProxy)
              yield* prepareProxy().pipe(
                Effect.mapError((failure) => new PreferenceFileFailure({ cause: new Error(failure.message) })),
              );
            if (
              previous.enabled !== saved.enabled ||
              (saved.enabled &&
                (previous.proxyUrl !== saved.proxyUrl ||
                  previous.hasUsername !== saved.hasUsername ||
                  previous.hasPassword !== saved.hasPassword ||
                  Boolean(next.password) ||
                  next.clearPassword))
            )
              yield* restartGemini();
            return saved;
          }),
        ),
      ),
    },
  };
}
