import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { type E2bFailure, e2bFailure } from "./e2b-desktop-errors";

export interface E2bUploadSource {
  path: string;
  handle: FileHandle;
}

/** The narrow host-filesystem boundary; it also permits controlled real-filesystem race checks. */
export interface E2bUploadFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

export type E2bOpenUploadSource = (root: string, path: string) => Effect.Effect<E2bUploadSource, E2bFailure>;

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

/** No byte is read until both the pre-open authority and the current path match the opened inode. */
export function openE2bUploadSource(
  root: string,
  input: string,
  files: E2bUploadFileSystem = { realpath, lstat, open },
): Effect.Effect<E2bUploadSource, E2bFailure> {
  const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => e2bFailure("filePath") });
  return Effect.gen(function* () {
    const source = yield* io(() => files.realpath(resolve(root, input)));
    if (!inside(root, source)) return yield* Effect.fail(e2bFailure("filePath"));
    const authorized = yield* io(() => files.lstat(source));
    if (!authorized.isFile() || authorized.isSymbolicLink()) return yield* Effect.fail(e2bFailure("filePath"));
    let retained = false;
    return yield* Effect.acquireUseRelease(
      io(() => files.open(source, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (handle) =>
        Effect.gen(function* () {
          const opened = yield* io(() => handle.stat());
          const currentPath = yield* io(() => files.realpath(source));
          const current = yield* io(() => files.lstat(currentPath));
          if (
            !opened.isFile() ||
            !inside(root, currentPath) ||
            opened.dev !== authorized.dev ||
            opened.ino !== authorized.ino ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino
          )
            return yield* Effect.fail(e2bFailure("filePath"));
          retained = true;
          return { path: source, handle };
        }),
      (handle) => (retained ? Effect.void : Effect.promise(() => handle.close().catch(() => undefined))),
    );
  });
}
