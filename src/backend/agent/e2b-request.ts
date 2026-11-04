import { Effect } from "effect";

/** Stop from the provider transport must interrupt cloud I/O, not only suppress its reply. */
export function withE2bRequestCancellation<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    if (signal?.aborted) return Effect.interrupt;
    if (!signal) return operation;
    const cancelled = Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
    return operation.pipe(Effect.raceFirst(cancelled));
  });
}
