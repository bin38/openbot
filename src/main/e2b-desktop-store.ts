import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  E2B_DEFAULT_TEMPLATE,
  E2B_DEFAULT_TIMEOUT_MINUTES,
  E2B_MAX_TIMEOUT_MINUTES,
  E2B_MIN_TIMEOUT_MINUTES,
  type E2bMachine,
  type E2bSettings,
  type SaveE2bSettingsInput,
} from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Semaphore } from "effect";
import { z } from "zod";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import { type E2bFailure, e2bFailure } from "./e2b-desktop-errors";
import type { SecretCipher } from "./provider-credential-store";

const machineSchema = z.object({
  agentId: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(256),
  state: z.enum(["running", "paused", "unknown", "missing"]),
  control: z.enum(["agent", "human"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const creationSchema = z.object({
  idempotencyKey: z.string().uuid(),
  template: z.string().min(1).max(256),
  timeoutMinutes: z.number().int().min(E2B_MIN_TIMEOUT_MINUTES).max(E2B_MAX_TIMEOUT_MINUTES),
  createdAt: z.string().datetime(),
});
const envelopeSchema = z.object({
  version: z.literal(1),
  template: z.string().min(1).max(256),
  timeoutMinutes: z.number().int().min(E2B_MIN_TIMEOUT_MINUTES).max(E2B_MAX_TIMEOUT_MINUTES),
  encryptedKey: z.string().nullable(),
  keyFingerprint: z.string().nullable().default(null),
  machines: z.record(z.string(), machineSchema),
  creations: z.record(z.string(), creationSchema),
});
type Envelope = z.infer<typeof envelopeSchema>;
export type E2bCreation = z.infer<typeof creationSchema>;

function emptyEnvelope(): Envelope {
  return {
    version: 1,
    template: E2B_DEFAULT_TEMPLATE,
    timeoutMinutes: E2B_DEFAULT_TIMEOUT_MINUTES,
    encryptedKey: null,
    keyFingerprint: null,
    machines: {},
    creations: {},
  };
}

/** Owns this host's encrypted E2B key and machine bindings; never writes application SQLite. */
export class E2bDesktopStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  readonly #writes = Semaphore.makeUnsafe(1);
  #data = emptyEnvelope();
  #key: string | null = null;
  #keyUnreadable = false;
  #fileUnreadable = false;
  #loaded = false;

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  load = Effect.fn("E2bDesktopStore.load")(function* (this: E2bDesktopStore) {
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(this.#path, "utf8");
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: () => e2bFailure("storeUnreadable"),
      }).pipe(
        Effect.flatMap((source) =>
          Effect.try({
            try: () => (source === null ? emptyEnvelope() : envelopeSchema.parse(JSON.parse(source))),
            catch: () => e2bFailure("storeUnreadable"),
          }),
        ),
      ),
    );
    this.#loaded = true;
    if (Result.isFailure(result)) {
      this.#fileUnreadable = true;
      return;
    }
    this.#data = result.success;
    if (!this.#data.encryptedKey) return;
    try {
      this.#key = this.#cipher.decrypt(Buffer.from(this.#data.encryptedKey, "base64"));
      registerSecretValue(this.#key);
    } catch {
      this.#keyUnreadable = true;
    }
  });

  settings(): E2bSettings {
    this.#assertLoaded();
    return {
      credentialStatus: this.#fileUnreadable || this.#keyUnreadable ? "unreadable" : this.#key ? "saved" : "missing",
      template: this.#data.template,
      timeoutMinutes: this.#data.timeoutMinutes,
      machines: Object.values(this.#data.machines).map((machine) => ({ ...machine })),
      pendingAgentIds: Object.keys(this.#data.creations),
    };
  }

  machine(agentId: string): E2bMachine | null {
    this.#assertLoaded();
    const machine = Object.hasOwn(this.#data.machines, agentId) ? this.#data.machines[agentId] : undefined;
    return machine ? { ...machine } : null;
  }

  key(): Effect.Effect<string, E2bFailure> {
    return Effect.suspend(() => {
      this.#assertLoaded();
      if (this.#fileUnreadable) return Effect.fail(e2bFailure("storeUnreadable"));
      if (this.#keyUnreadable) return Effect.fail(e2bFailure("keyUnreadable"));
      return this.#key ? Effect.succeed(this.#key) : Effect.fail(e2bFailure("keyMissing"));
    });
  }

  save = Effect.fn("E2bDesktopStore.save")(function* (this: E2bDesktopStore, input: SaveE2bSettingsInput) {
    yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#editable();
        const apiKey = input.apiKey?.trim() || null;
        const fingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : null;
        const changesAccount = fingerprint !== null && fingerprint !== this.#data.keyFingerprint;
        const hasMachines = Object.keys(this.#data.machines).length > 0 || Object.keys(this.#data.creations).length > 0;
        if (input.clearApiKey && hasMachines && !input.confirmKeyReplacement)
          return yield* Effect.fail(e2bFailure("keyInUse"));
        if (Object.keys(this.#data.creations).length > 0 && (input.template !== this.#data.template || changesAccount))
          return yield* Effect.fail(e2bFailure("creationPending"));
        if (changesAccount && hasMachines && !input.confirmKeyReplacement)
          return yield* Effect.fail(e2bFailure("keyReplacement"));
        const next = structuredClone(this.#data);
        next.template = input.template;
        next.timeoutMinutes = input.timeoutMinutes;
        if (input.clearApiKey) next.encryptedKey = null;
        else if (apiKey) {
          registerSecretValue(apiKey);
          next.encryptedKey = yield* Effect.try({
            try: () => this.#cipher.encrypt(apiKey).toString("base64"),
            catch: () => e2bFailure("keyUnreadable"),
          });
          next.keyFingerprint = fingerprint;
        }
        yield* this.#commit(next);
        if (apiKey || input.clearApiKey) {
          this.#key = input.clearApiKey ? null : apiKey;
          this.#keyUnreadable = false;
        }
      }).pipe(Effect.uninterruptible),
    );
    return this.settings();
  });

  reserveCreation = Effect.fn("E2bDesktopStore.reserveCreation")(function* (this: E2bDesktopStore, agentId: string) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#editable();
        const previous = Object.hasOwn(this.#data.creations, agentId) ? this.#data.creations[agentId] : undefined;
        if (previous) return { ...previous };
        const creation: E2bCreation = {
          idempotencyKey: randomUUID(),
          template: this.#data.template,
          timeoutMinutes: this.#data.timeoutMinutes,
          createdAt: new Date().toISOString(),
        };
        const next = structuredClone(this.#data);
        next.creations = { ...next.creations, [agentId]: creation };
        yield* this.#commit(next);
        return { ...creation };
      }).pipe(Effect.uninterruptible),
    );
  });

  put = Effect.fn("E2bDesktopStore.put")(function* (this: E2bDesktopStore, machine: E2bMachine) {
    yield* this.#edit((next) => {
      next.machines = { ...next.machines, [machine.agentId]: { ...machine } };
      delete next.creations[machine.agentId];
    });
    return { ...machine };
  });

  forget(agentId: string): Effect.Effect<void, E2bFailure> {
    return this.#edit((next) => {
      delete next.machines[agentId];
      delete next.creations[agentId];
    });
  }

  #edit(change: (next: Envelope) => void): Effect.Effect<void, E2bFailure> {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#editable();
        const next = structuredClone(this.#data);
        change(next);
        yield* this.#commit(next);
      }).pipe(Effect.uninterruptible),
    );
  }

  #editable(): Effect.Effect<void, E2bFailure> {
    return Effect.suspend(() => {
      this.#assertLoaded();
      return this.#fileUnreadable ? Effect.fail(e2bFailure("storeUnreadable")) : Effect.void;
    });
  }

  #commit = Effect.fn("E2bDesktopStore.commit")(function* (this: E2bDesktopStore, next: Envelope) {
    yield* writeJsonFileAtomically(this.#path, next, { createDirectory: true }).pipe(
      Effect.mapError(() => e2bFailure("storeWriteFailed")),
    );
    this.#data = next;
  });

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("E2B state must be loaded before use.");
  }
}
