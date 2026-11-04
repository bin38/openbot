import type { MobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect, Exit, Semaphore } from "effect";
import type { LocalMobileConsent, LocalMobileConsentStore } from "./local-mobile-consent-store";
import { RemoteWorkflowError, toRemoteWorkflowError } from "./remote-service-effects";

const logger = createOpenBotLogger("local-mobile-publication");

interface LocalMobilePublicationOptions {
  accountOrigin: string;
  consent: LocalMobileConsentStore;
  getAccountId(): string | null;
  getHost(): MobileConnectHostBinding | null;
  startLoopback(): Effect.Effect<unknown, RemoteWorkflowError>;
  register(): Effect.Effect<unknown, RemoteWorkflowError>;
  publish(): Effect.Effect<void, RemoteWorkflowError>;
  stop(): Effect.Effect<void, RemoteWorkflowError>;
  closeRemoteSessions(): void;
  changed(): void;
}

type PublicationAttempt = LocalMobileConsent;

/** Child servers use their parent's machine grant and have no desktop publication consent store. */
export function createLocalMobilePublication(
  options: Omit<LocalMobilePublicationOptions, "consent"> & { consent: LocalMobileConsentStore | undefined },
): LocalMobilePublication | null {
  return options.consent ? new LocalMobilePublication({ ...options, consent: options.consent }) : null;
}

/** An explicit account grant to publish a local workspace. It never changes its local identity. */
export class LocalMobilePublication {
  readonly #options: LocalMobilePublicationOptions;
  readonly #gate = Semaphore.makeUnsafe(1);
  readonly #consentWrites = Semaphore.makeUnsafe(1);
  readonly #sessions = new Set<string>();
  #attempt: PublicationAttempt | null = null;
  #ready = false;
  #restoreRevoked = false;
  #restoreAttempted = false;
  #generation = 0;
  #accountId: string | null;

  constructor(options: LocalMobilePublicationOptions) {
    this.#options = options;
    this.#accountId = options.getAccountId();
  }

  isPublished(): boolean {
    return this.#ready && this.#attempt !== null && this.#isCurrent(this.#attempt);
  }

  readonly publish = Effect.fn("LocalMobilePublication.publish")(() =>
    this.#gate.withPermit(this.#publish(false, this.#generation)),
  );

  readonly restore = Effect.fn("LocalMobilePublication.restore")(() =>
    this.#gate.withPermit(this.#publish(true, this.#generation)),
  );

  readonly #publish = Effect.fn("LocalMobilePublication.publishGranted")(function* (
    this: LocalMobilePublication,
    restoreOnly: boolean,
    generation: number,
  ): Effect.fn.Return<void, RemoteWorkflowError> {
    yield* this.#consentWrites.withPermit(Effect.void);
    if (generation !== this.#generation)
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.accountChangedDuringUpdate")) });
    if (restoreOnly && (this.#restoreRevoked || this.#restoreAttempted)) return;
    const accountId = this.#options.getAccountId();
    if (!accountId) {
      if (restoreOnly) return;
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.auth.signInFirst")) });
    }
    const host = this.#options.getHost();
    if (!host) {
      if (restoreOnly) return;
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.nameBeforePublish")) });
    }
    if (restoreOnly) {
      const saved = this.#options.consent.get().consent;
      if (!saved) return;
      if (!this.#matchesBinding(saved)) {
        yield* this.#clearConsent();
        return;
      }
      this.#restoreAttempted = true;
    }
    if (this.isPublished()) return;
    const attempt = { accountId, accountOrigin: this.#options.accountOrigin, ...host };
    this.#attempt = attempt;
    this.#ready = false;
    yield* Effect.gen({ self: this }, function* () {
      // Finish a previous disconnect before a new account can start Signal.
      yield* this.#options.stop();
      yield* this.#assertCurrent(attempt);
      yield* this.#options.startLoopback();
      yield* this.#assertCurrent(attempt);
      yield* this.#options.register();
      yield* this.#assertCurrent(attempt);
      yield* this.#options.publish();
      yield* this.#assertCurrent(attempt);
      // The opt-in follows a successful Signal connection, never a mere sign-in or start attempt.
      yield* this.#consentWrites.withPermit(
        Effect.gen({ self: this }, function* () {
          yield* this.#assertCurrent(attempt);
          yield* this.#options.consent.set({ consent: attempt }).pipe(toRemoteWorkflowError);
          yield* this.#assertCurrent(attempt);
        }),
      );
      this.#ready = true;
      this.#restoreRevoked = false;
      this.#options.changed();
    }).pipe(
      Effect.onExit((exit) => {
        if (!Exit.isFailure(exit)) return Effect.void;
        this.reset();
        return this.#options.stop();
      }),
    );
  });

  /** Also checks after I/O, so a ticket verified for a previous account cannot be used. */
  withAccount<A>(operation: Effect.Effect<A, RemoteWorkflowError>): Effect.Effect<A, RemoteWorkflowError> {
    return Effect.suspend(() => {
      const attempt = this.#attempt;
      if (!attempt)
        return Effect.fail(new RemoteWorkflowError({ cause: new Error(sourceText("error.auth.signInFirst")) }));
      return this.#assertCurrent(attempt).pipe(
        Effect.andThen(operation),
        Effect.tap(() => this.#assertCurrent(attempt)),
      );
    });
  }

  /** Invalidate now; the account event's caller runs the returned gateway teardown. */
  accountChanged(accountId: string | null, revokeSaved = accountId === null): Effect.Effect<void, RemoteWorkflowError> {
    const changed =
      this.#accountId !== accountId ||
      revokeSaved ||
      (this.#attempt !== null && (this.#attempt.accountId !== accountId || !this.#isCurrent(this.#attempt)));
    this.#accountId = accountId;
    if (changed || accountId === null) this.#restoreAttempted = false;
    if (changed) this.reset();
    const stop = changed ? this.#options.stop() : Effect.void;
    if (revokeSaved) this.#restoreRevoked = true;
    if (!revokeSaved && accountId === null) return stop;
    // Read under the write lock: a previous grant can still be saving when the account changes.
    return stop.pipe(
      Effect.onExit(() =>
        this.#consentWrites
          .withPermit(
            Effect.gen({ self: this }, function* () {
              const saved = this.#options.consent.get().consent;
              if (revokeSaved || (saved !== null && saved.accountId !== accountId)) {
                this.#restoreRevoked = true;
                yield* this.#options.consent.set({ consent: null }).pipe(toRemoteWorkflowError);
              }
            }),
          )
          .pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                logger.error("Unable to clear the saved phone publication consent:", toLogValue(error.cause));
              }),
            ),
          ),
      ),
    );
  }

  /** An explicit stop revokes the saved opt-in; process shutdown calls reset instead. */
  revoke(): Effect.Effect<void, RemoteWorkflowError> {
    this.reset();
    const clear = this.#clearConsent();
    return this.#options.stop().pipe(
      Effect.onExit(() =>
        clear.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              logger.error("Unable to clear the saved phone publication consent:", toLogValue(error.cause));
            }),
          ),
        ),
      ),
    );
  }

  signalFailed(): void {
    this.#ready = false;
    this.#options.changed();
  }

  rememberSession(session: { hostId: string; sessionId: string }): void {
    if (this.#attempt && this.#isCurrent(this.#attempt) && session.hostId === this.#attempt.hostId)
      this.#sessions.add(session.sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.#attempt !== null && this.#isCurrent(this.#attempt) && this.#sessions.has(sessionId);
  }

  reset(): void {
    this.#generation += 1;
    this.#ready = false;
    this.#attempt = null;
    this.#sessions.clear();
    this.#options.closeRemoteSessions();
    this.#options.changed();
  }

  #isCurrent(attempt: PublicationAttempt): boolean {
    return this.#attempt === attempt && this.#matchesBinding(attempt);
  }

  #matchesBinding(attempt: PublicationAttempt): boolean {
    const host = this.#options.getHost();
    return (
      this.#options.getAccountId() === attempt.accountId &&
      this.#options.accountOrigin === attempt.accountOrigin &&
      host?.hostId === attempt.hostId &&
      host.fingerprint === attempt.fingerprint
    );
  }

  #clearConsent(): Effect.Effect<void, RemoteWorkflowError> {
    this.#restoreRevoked = true;
    return this.#consentWrites.withPermit(
      this.#options.consent.set({ consent: null }).pipe(Effect.asVoid, toRemoteWorkflowError),
    );
  }

  #assertCurrent(attempt: PublicationAttempt): Effect.Effect<void, RemoteWorkflowError> {
    return Effect.suspend(() =>
      this.#isCurrent(attempt)
        ? Effect.void
        : Effect.fail(
            new RemoteWorkflowError({ cause: new Error(sourceText("error.host.accountChangedDuringUpdate")) }),
          ),
    );
  }
}
