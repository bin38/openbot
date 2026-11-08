/**
 * Holds routines while the computer sleeps, and starts them again only when the network is back.
 * A routine that fires in the first seconds after a wake runs before Wi-Fi joins and fails.
 */
export interface RoutineWakeOptions {
  routines: { suspendRoutines(): void; resumeRoutines(): void };
  isOnline: () => boolean;
  pollMs?: number;
  /** Consecutive online reads before routines resume. One read can be true before the link is up. */
  onlineReads?: number;
  /** Routines resume after this even when the computer stays offline, so they never stay held. */
  maxWaitMs?: number;
  /** Internal deadline injection for the real wake-service fixture. */
  lostResumeMs?: number;
}

/** Awake time after a suspend with no resume event, before routines resume without one. */
const LOST_RESUME_MS = 10 * 60_000;

export class RoutineWake {
  readonly #routines: RoutineWakeOptions["routines"];
  readonly #isOnline: () => boolean;
  readonly #pollMs: number;
  readonly #onlineReads: number;
  readonly #maxWaitMs: number;
  readonly #lostResumeMs: number;
  #poll: NodeJS.Timeout | null = null;
  #lostResume: NodeJS.Timeout | null = null;

  constructor(options: RoutineWakeOptions) {
    this.#routines = options.routines;
    this.#isOnline = options.isOnline;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#onlineReads = options.onlineReads ?? 2;
    this.#maxWaitMs = options.maxWaitMs ?? 120_000;
    this.#lostResumeMs = options.lostResumeMs ?? LOST_RESUME_MS;
  }

  suspend(): void {
    this.dispose();
    this.#routines.suspendRoutines();
    // The timer does not advance while the computer sleeps, so it ends only after a wake that macOS
    // or Electron did not report. Without it, every routine would stay held until a restart.
    this.#lostResume = setTimeout(() => this.resume(), this.#lostResumeMs);
    this.#lostResume.unref?.();
  }

  resume(): void {
    this.dispose();
    const deadline = Date.now() + this.#maxWaitMs;
    let reads = 0;
    const check = () => {
      reads = this.#isOnline() ? reads + 1 : 0;
      if (reads >= this.#onlineReads || Date.now() >= deadline) {
        this.#poll = null;
        this.#routines.resumeRoutines();
        return;
      }
      this.#poll = setTimeout(check, this.#pollMs);
      this.#poll.unref?.();
    };
    check();
  }

  dispose(): void {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = null;
    if (this.#lostResume) clearTimeout(this.#lostResume);
    this.#lostResume = null;
  }
}
