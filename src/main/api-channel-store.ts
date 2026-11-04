import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApiChannelRun, ApiChannelSummary, SaveApiChannelInput } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import {
  ApiChannelDefinitionSchema,
  ApiChannelFailure,
  apiChannelFailure,
  apiChannelUrl,
  parseApiChannelDefinition,
} from "./api-channel-schema";
import type { CustomProviderCipher } from "./custom-provider-store";

const entrySchema = Schema.Struct({
  id: Schema.String,
  definition: ApiChannelDefinitionSchema,
  enabled: Schema.Boolean,
  source: Schema.Literals(["user", "agent"]),
  updatedAt: Schema.String,
  sealedKey: Schema.NullOr(Schema.String),
});
const envelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  channels: Schema.Array(entrySchema),
  runs: Schema.Array(Schema.Struct({ id: Schema.String, sealed: Schema.String })),
});
type Entry = typeof entrySchema.Type;
export interface StoredApiArtifact {
  id: string;
  fileName: string;
  mimeType: string;
  url?: string;
  path?: string;
}
export interface StoredApiRun {
  owner: string;
  revision: string;
  /** Absent on earlier records; reading history does not invent a creation time. */
  createdAt?: string;
  updatedAt?: string;
  result: ApiChannelRun;
  job: { operationId: string; parameter: string; value: string | number } | null;
  artifacts: StoredApiArtifact[];
}

/** This store is independent of chat provider configuration and never returns plaintext credentials. */
export class ApiChannelStore {
  #entries: Entry[] = [];
  #runs: { id: string; sealed: string }[] = [];
  #readOnly = false;
  #gate = Semaphore.makeUnsafe(1);
  constructor(
    readonly path: string,
    readonly cipher: CustomProviderCipher,
  ) {}
  load(): Effect.Effect<void> {
    return Effect.promise(async () => {
      try {
        const raw = await readFile(this.path, "utf8");
        const parsed = Schema.decodeUnknownSync(envelopeSchema)(JSON.parse(raw));
        this.#entries = parsed.channels.map((entry) => ({
          ...entry,
          definition: parseApiChannelDefinition(JSON.stringify(entry.definition)),
        }));
        this.#runs = [...parsed.runs];
        for (const entry of this.#entries) {
          try {
            this.key(entry.id);
          } catch {
            /* Preserve unreadable credentials. */
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.#readOnly = true;
      }
    });
  }
  list(): ApiChannelSummary[] {
    return this.#entries.map(({ sealedKey, ...entry }) => {
      let credentialStatus: ApiChannelSummary["credentialStatus"] =
        entry.definition.auth.type === "none" ? "not-required" : "missing";
      if (sealedKey) {
        try {
          this.key(entry.id);
          credentialStatus = "saved";
        } catch {
          credentialStatus = "unreadable";
        }
      }
      return { ...structuredClone(entry), credentialStatus };
    });
  }
  entry(id: string): ApiChannelSummary {
    const entry = this.list().find((entry) => entry.id === id);
    if (!entry) throw apiChannelFailure("unavailable");
    return entry;
  }
  key(id: string): string | null {
    const sealed = this.#entries.find((entry) => entry.id === id)?.sealedKey;
    if (!sealed) return null;
    try {
      const entry = this.#entries.find((entry) => entry.id === id);
      if (!entry) throw apiChannelFailure("credential");
      const key = this.#credential(sealed, entry.definition.baseUrl);
      registerSecretValue(key, { allowShort: true });
      return key;
    } catch {
      throw apiChannelFailure("credential");
    }
  }
  save(
    input: SaveApiChannelInput,
    source: "user" | "agent" = "user",
  ): Effect.Effect<ApiChannelSummary, ApiChannelFailure> {
    return this.#gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const nextState = yield* Effect.try({
          try: () => {
            const definition = parseApiChannelDefinition(input.definitionJson);
            const newKey = input.apiKey?.trim() || null;
            if (newKey && input.definitionJson.includes(newKey)) throw apiChannelFailure("invalid");
            for (const entry of this.#entries) {
              let known: string | null = null;
              try {
                known = this.key(entry.id);
              } catch {
                /* Preserve unreadable keys without using them. */
              }
              if (known && input.definitionJson.includes(known)) throw apiChannelFailure("invalid");
            }
            const old = input.id ? this.#entries.find((entry) => entry.id === input.id) : undefined;
            if (input.id && !old) throw apiChannelFailure("unavailable");
            if (newKey && input.clearApiKey) throw apiChannelFailure("invalid");
            if (
              old?.sealedKey &&
              apiChannelUrl(old.definition.baseUrl).origin !== apiChannelUrl(definition.baseUrl).origin &&
              !newKey &&
              !input.clearApiKey
            )
              throw apiChannelFailure("origin");
            let sealedKey = input.clearApiKey ? null : (old?.sealedKey ?? null);
            if (newKey) {
              if (!this.cipher.canPersist()) throw apiChannelFailure("credential");
              registerSecretValue(newKey, { allowShort: true });
              sealedKey = this.cipher
                .encrypt(JSON.stringify({ key: newKey, origin: apiChannelUrl(definition.baseUrl).origin }))
                .toString("base64");
            }
            if (input.enabled && definition.auth.type !== "none" && !sealedKey) throw apiChannelFailure("credential");
            if (input.enabled && sealedKey) this.#credential(sealedKey, definition.baseUrl);
            const id = old?.id ?? randomUUID();
            const next = {
              id,
              definition,
              enabled: source === "agent" ? false : input.enabled,
              source,
              updatedAt: new Date().toISOString(),
              sealedKey,
            };
            const entries = [...this.#entries.filter((entry) => entry.id !== id), next];
            if (entries.length > 128) throw apiChannelFailure("storage");
            return { entries, id };
          },
          catch: safeStoreFailure,
        });
        yield* this.#write(nextState.entries, this.#runs);
        this.#entries = nextState.entries;
        return this.entry(nextState.id);
      }).pipe(Effect.uninterruptible),
    );
  }
  delete(id: string): Effect.Effect<void, ApiChannelFailure> {
    return this.#gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const entries = this.#entries.filter((entry) => entry.id !== id);
        yield* this.#write(entries, this.#runs);
        this.#entries = entries;
      }).pipe(Effect.uninterruptible),
    );
  }
  run(id: string): StoredApiRun | null {
    const stored = this.#runs.find((run) => run.id === id);
    if (!stored) return null;
    try {
      // Runs are written by this process, encrypted and authenticated by the injected OS cipher.
      const decoded = JSON.parse(this.cipher.decrypt(Buffer.from(stored.sealed, "base64")));
      return decodeStoredRun(decoded);
    } catch {
      throw apiChannelFailure("storage");
    }
  }
  recentRuns(channelId?: string): StoredApiRun[] {
    const result: StoredApiRun[] = [];
    for (let index = this.#runs.length - 1; index >= 0 && result.length < 50; index -= 1) {
      const entry = this.#runs[index];
      if (!entry) continue;
      const run = this.run(entry.id);
      if (run && (channelId === undefined || run.result.channelId === channelId)) result.push(run);
    }
    return result;
  }
  artifact(id: string): { run: StoredApiRun; artifact: StoredApiArtifact } | null {
    for (const entry of this.#runs) {
      const run = this.run(entry.id);
      const artifact = run?.artifacts.find((artifact) => artifact.id === id);
      if (run && artifact) return { run, artifact };
    }
    return null;
  }
  putRun(run: StoredApiRun): Effect.Effect<void, ApiChannelFailure> {
    return this.#gate.withPermit(this.#saveRun(run));
  }
  cacheArtifact(runId: string, artifactId: string, path: string): Effect.Effect<void, ApiChannelFailure> {
    return this.#gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const run = yield* Effect.try({ try: () => this.run(runId), catch: safeStoreFailure });
        const artifact = run?.artifacts.find((artifact) => artifact.id === artifactId);
        if (!run || !artifact) return yield* Effect.fail(apiChannelFailure("artifact"));
        artifact.path = path;
        yield* this.#saveRun(run);
      }).pipe(Effect.uninterruptible),
    );
  }
  #saveRun(run: StoredApiRun): Effect.Effect<void, ApiChannelFailure> {
    return Effect.gen({ self: this }, function* () {
      const sealed = yield* Effect.try({
        try: () => {
          if (!this.cipher.canPersist()) throw apiChannelFailure("credential");
          const current = this.run(run.result.id);
          const now = new Date().toISOString();
          const createdAt = current ? (current.createdAt ?? run.createdAt) : (run.createdAt ?? now);
          const artifacts = run.artifacts.map((artifact) => {
            const cached = current?.artifacts.find(
              (item) => item.id === artifact.id && item.url === artifact.url && item.fileName === artifact.fileName,
            )?.path;
            return !artifact.path && cached ? { ...artifact, path: cached } : artifact;
          });
          return this.cipher
            .encrypt(
              JSON.stringify({
                ...run,
                ...(createdAt === undefined ? {} : { createdAt }),
                updatedAt: now,
                artifacts,
              }),
            )
            .toString("base64");
        },
        catch: safeStoreFailure,
      });
      const runs = [...this.#runs.filter((entry) => entry.id !== run.result.id), { id: run.result.id, sealed }];
      yield* this.#write(this.#entries, runs);
      this.#runs = runs;
    }).pipe(Effect.uninterruptible);
  }
  #write(
    channels: readonly Entry[],
    runs: readonly { id: string; sealed: string }[],
  ): Effect.Effect<void, ApiChannelFailure> {
    if (this.#readOnly) return Effect.fail(apiChannelFailure("storage"));
    return writeJsonFileAtomically(this.path, { version: 1, channels, runs }, { createDirectory: true }).pipe(
      Effect.mapError(() => apiChannelFailure("storage")),
    );
  }
  #credential(sealed: string, baseUrl: string): string {
    try {
      const value = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String, origin: Schema.String }))(
        JSON.parse(this.cipher.decrypt(Buffer.from(sealed, "base64"))),
      );
      if (value.origin !== apiChannelUrl(baseUrl).origin || !value.key.trim()) throw apiChannelFailure("credential");
      return value.key;
    } catch {
      throw apiChannelFailure("credential");
    }
  }
}
function safeStoreFailure(error: unknown): ApiChannelFailure {
  return error instanceof ApiChannelFailure ? error : apiChannelFailure("storage");
}
const artifactSchema = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  mimeType: Schema.String,
  url: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const runSchema = Schema.Struct({
  owner: Schema.String,
  revision: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  result: Schema.Struct({
    id: Schema.String,
    channelId: Schema.String,
    operationId: Schema.String,
    status: Schema.Literals(["completed", "pending", "failed", "unknown"]),
    output: Schema.MutableJson,
    outputTruncated: Schema.optionalKey(Schema.Boolean),
    artifacts: Schema.mutable(
      Schema.Array(Schema.Struct({ id: Schema.String, fileName: Schema.String, mimeType: Schema.String })),
    ),
    message: Schema.NullOr(Schema.String),
  }),
  job: Schema.NullOr(
    Schema.Struct({
      operationId: Schema.String,
      parameter: Schema.String,
      value: Schema.Union([Schema.String, Schema.Number]),
    }),
  ),
  artifacts: Schema.mutable(Schema.Array(artifactSchema)),
});
function decodeStoredRun(value: unknown): StoredApiRun {
  return Schema.decodeUnknownSync(runSchema)(value);
}
