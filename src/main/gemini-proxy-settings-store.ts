import {
  DEFAULT_GEMINI_PROXY_SETTINGS,
  type GeminiProxySettings,
  normalizeGeminiProxyUrl,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

export const GEMINI_PROXY_SETTINGS_FILE = "openbot-gemini-proxy-v1.json";
const settingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  proxyUrl: Schema.String.check(Schema.makeFilter((value) => normalizeGeminiProxyUrl(value) !== null)),
});
const fileSchema = Schema.Struct({ version: Schema.Literal(1), settings: settingsSchema });
const decodeFile = Schema.decodeUnknownOption(fileSchema, { onExcessProperty: "error" });

/** Only Gemini reads this store. An unreadable file blocks that provider instead of using a direct route. */
export class GeminiProxySettingsStore {
  #settings: typeof settingsSchema.Type = { ...DEFAULT_GEMINI_PROXY_SETTINGS };
  #unreadable = false;
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(private readonly path: string) {}

  readonly load = Effect.fn("GeminiProxySettings.load")(function* (this: GeminiProxySettingsStore) {
    const result = yield* Effect.result(readPreferenceFile(this.path, decodeFile));
    if (Result.isFailure(result)) {
      if (!isMissingFileError(result.failure.cause)) this.#unreadable = true;
      return;
    }
    if (result.success._tag === "None") {
      this.#unreadable = true;
      return;
    }
    this.#settings = result.success.value.settings;
  }).bind(this);

  get(): GeminiProxySettings {
    if (this.#unreadable) throw new Error(sourceText("error.provider.geminiProxySettingsReadOnly"));
    return { ...this.#settings };
  }

  readonly set = Effect.fn("GeminiProxySettings.set")(function* (
    this: GeminiProxySettingsStore,
    next: GeminiProxySettings,
  ) {
    if (this.#unreadable)
      return yield* new PreferenceFileFailure({
        cause: new Error(sourceText("error.provider.geminiProxySettingsReadOnly")),
      });
    return yield* this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          yield* writePreferenceFile(this.path, { version: 1, settings: next }, { createDirectory: true });
          this.#settings = { ...next };
          return this.get();
        }),
      ),
    );
  }).bind(this);
}
