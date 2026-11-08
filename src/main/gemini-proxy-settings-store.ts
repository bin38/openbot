import {
  DEFAULT_GEMINI_PROXY_SETTINGS,
  type GeminiProxySettings,
  isGeminiProxyUsername,
  normalizeGeminiProxyUrl,
  type SetGeminiProxySettingsInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValues } from "@openbot/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";
import type { SecretCipher } from "./provider-credential-store";

export const GEMINI_PROXY_SETTINGS_FILE = "openbot-gemini-proxy-v1.json";
const storedSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  proxyUrl: Schema.String.check(Schema.makeFilter((value) => normalizeGeminiProxyUrl(value) !== null)),
  encryptedCredentials: Schema.optionalKey(Schema.String),
});
const fileSchema = Schema.Struct({ version: Schema.Literal(1), settings: storedSettingsSchema });
const decodeFile = Schema.decodeUnknownOption(fileSchema, { onExcessProperty: "error" });
const decodeCredentials = Schema.decodeUnknownOption(
  Schema.Struct({ username: Schema.String, password: Schema.String }),
  { onExcessProperty: "error" },
);

/** Main-only configuration. Never return this through IPC or diagnostics. */
export interface GeminiProxyRuntimeConfig {
  enabled: boolean;
  proxyUrl: string;
  username: string;
  password: string;
}

export class GeminiProxySettingsStore {
  #settings: typeof storedSettingsSchema.Type = { ...DEFAULT_GEMINI_PROXY_SETTINGS };
  #username = "";
  #password = "";
  #unreadable = false;
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(
    private readonly path: string,
    private readonly cipher?: SecretCipher,
  ) {}

  readonly load = Effect.fn("GeminiProxySettings.load")(function* (this: GeminiProxySettingsStore) {
    const result = yield* Effect.result(
      readPreferenceFile(this.path, (value) => {
        const decoded = decodeFile(value);
        if (decoded._tag === "None") return null;
        const normalizedUrl = normalizeGeminiProxyUrl(decoded.value.settings.proxyUrl);
        if (!normalizedUrl) return null;
        const stored = { ...decoded.value.settings, proxyUrl: normalizedUrl };
        let username = "";
        let password = "";
        if (stored.encryptedCredentials) {
          if (!this.cipher) throw new Error("Secure storage is unavailable.");
          const decodedCredentials = decodeCredentials(
            JSON.parse(this.cipher.decrypt(Buffer.from(stored.encryptedCredentials, "base64"))),
          );
          if (decodedCredentials._tag === "None") return null;
          username = decodedCredentials.value.username;
          password = decodedCredentials.value.password;
        }
        if (!isGeminiProxyUsername(username) || Buffer.byteLength(password) > 255) return null;
        if (stored.enabled && Boolean(username) !== Boolean(password)) return null;
        if (!stored.proxyUrl.startsWith("socks5:") && (username || password)) return null;
        registerSecretValues([username, password]);
        return { settings: stored, username, password };
      }),
    );
    if (Result.isFailure(result)) {
      if (!isMissingFileError(result.failure.cause)) this.#unreadable = true;
      return;
    }
    if (!result.success) {
      this.#unreadable = true;
      return;
    }
    this.#settings = result.success.settings;
    this.#username = result.success.username;
    this.#password = result.success.password;
  }).bind(this);

  get(): GeminiProxySettings {
    if (this.#unreadable) throw new Error(sourceText("error.provider.geminiProxySettingsReadOnly"));
    const { enabled, proxyUrl } = this.#settings;
    return {
      enabled,
      proxyUrl,
      ...(this.#username ? { hasUsername: true } : {}),
      ...(this.#password ? { hasPassword: true } : {}),
    };
  }

  runtimeConfig(): GeminiProxyRuntimeConfig {
    const summary = this.get();
    return { enabled: summary.enabled, proxyUrl: summary.proxyUrl, username: this.#username, password: this.#password };
  }

  readonly set = Effect.fn("GeminiProxySettings.set")(function* (
    this: GeminiProxySettingsStore,
    input: SetGeminiProxySettingsInput,
  ) {
    return yield* this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          if (this.#unreadable)
            return yield* new PreferenceFileFailure({
              cause: new Error(sourceText("error.provider.geminiProxySettingsReadOnly")),
            });
          const proxyUrl = normalizeGeminiProxyUrl(input.proxyUrl);
          if (!proxyUrl)
            return yield* new PreferenceFileFailure({ cause: new Error(sourceText("error.provider.geminiProxyUrl")) });
          const username = input.clearPassword ? input.username || "" : input.username || this.#username;
          const changedAddress = proxyUrl !== this.#settings.proxyUrl;
          const changedIdentity = changedAddress || username !== this.#username;
          if (
            changedIdentity &&
            this.#password &&
            (!input.password || (changedAddress && !input.username)) &&
            !input.clearPassword
          )
            return yield* new PreferenceFileFailure({
              cause: new Error(sourceText("error.provider.geminiProxyNewAddress")),
            });
          const password = input.clearPassword ? "" : input.password || this.#password;
          if (input.enabled && username.length > 0 !== password.length > 0)
            return yield* new PreferenceFileFailure({
              cause: new Error(sourceText("error.provider.geminiProxyCredentials")),
            });
          if (!proxyUrl.startsWith("socks5:") && (username || password))
            return yield* new PreferenceFileFailure({
              cause: new Error(sourceText("error.provider.geminiProxySocksCredentials")),
            });
          registerSecretValues([username, password]);
          let encryptedCredentials: string | undefined;
          if (username || password) {
            const encrypted = yield* Effect.try({
              try: () => {
                if (!this.cipher) throw new Error("Secure storage is unavailable.");
                return this.cipher.encrypt(JSON.stringify({ username, password })).toString("base64");
              },
              catch: () =>
                new PreferenceFileFailure({ cause: new Error(sourceText("error.provider.geminiProxySecureStorage")) }),
            });
            encryptedCredentials = encrypted;
          }
          const next = { enabled: input.enabled, proxyUrl, ...(encryptedCredentials ? { encryptedCredentials } : {}) };
          yield* writePreferenceFile(this.path, { version: 1, settings: next }, { createDirectory: true });
          this.#settings = next;
          this.#username = username;
          this.#password = password;
          return this.get();
        }),
      ),
    );
  }).bind(this);
}
