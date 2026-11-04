import { createHash, type Hash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachmentUploadState,
  type BeginAttachmentUpload,
  type CompleteAttachmentUpload,
  type WriteAttachmentUpload,
} from "@openbot/contracts/team-protocol/streaming-attachments-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { attachmentCall } from "./attachment-effects";

const IDLE_MILLISECONDS = 30 * 60 * 1_000;
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_OWNER = 10;

interface UploadSession {
  id: string;
  owner: string;
  directory: string;
  path: string;
  file: FileHandle;
  size: number;
  offset: number;
  digest: Hash;
  touched: number;
  busy: boolean;
  idle: Promise<void>;
  release: (() => void) | null;
  sealed: boolean;
}

/** Owns temporary upload files only. Session IDs never authorize another member to use a file. */
export class AttachmentUploadSessions {
  readonly #directory: string;
  readonly #sessions = new Map<string, UploadSession>();
  readonly #starting = new Map<string, number>();
  #initialization: Promise<void> | null = null;
  #closing = false;

  constructor(directory: string) {
    this.#directory = directory;
  }

  readonly begin = Effect.fn("AttachmentUploads.begin")((owner: string, input: BeginAttachmentUpload) =>
    attachmentCall(async (): Promise<AttachmentUploadState> => {
      await this.#initialize();
      await this.#removeExpired();
      if (this.#closing) throw new Error(sourceText("error.attachment.uploadUnavailable"));
      if (
        this.#sessions.size + [...this.#starting.values()].reduce((sum, count) => sum + count, 0) >= MAX_SESSIONS ||
        [...this.#sessions.values()].filter((session) => session.owner === owner).length +
          (this.#starting.get(owner) ?? 0) >=
          MAX_SESSIONS_PER_OWNER
      )
        throw new Error(sourceText("error.attachment.uploadBusy"));
      this.#starting.set(owner, (this.#starting.get(owner) ?? 0) + 1);
      const id = randomUUID();
      const directory = join(this.#directory, id);
      const path = join(directory, input.name);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = await open(path, "wx", 0o600);
        if (this.#closing) {
          await file.close();
          throw new Error(sourceText("error.attachment.uploadUnavailable"));
        }
        const session: UploadSession = {
          id,
          owner,
          directory,
          path,
          file,
          size: input.size,
          offset: 0,
          digest: createHash("sha256"),
          touched: Date.now(),
          busy: false,
          idle: Promise.resolve(),
          release: null,
          sealed: false,
        };
        this.#sessions.set(id, session);
        return this.#state(session);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      } finally {
        const pending = (this.#starting.get(owner) ?? 1) - 1;
        if (pending > 0) this.#starting.set(owner, pending);
        else this.#starting.delete(owner);
      }
    }),
  );

  readonly write = Effect.fn("AttachmentUploads.write")((owner: string, input: WriteAttachmentUpload) =>
    attachmentCall(async (): Promise<AttachmentUploadState> => {
      const session = this.#require(owner, input.id);
      if (session.busy || session.sealed) throw new Error(sourceText("error.attachment.uploadBusy"));
      const bytes = Buffer.from(input.base64, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > ATTACHMENT_CHUNK_BYTES ||
        bytes.toString("base64") !== input.base64 ||
        input.offset !== session.offset ||
        bytes.length > session.size - session.offset
      )
        throw new Error(sourceText("error.attachment.uploadOffset"));
      this.#lock(session);
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await session.file.write(bytes, written, bytes.length - written, session.offset + written);
          if (result.bytesWritten === 0) throw new Error(sourceText("error.attachment.uploadWriteFailed"));
          written += result.bytesWritten;
        }
        session.digest.update(bytes);
        session.offset += bytes.length;
        session.touched = Date.now();
        return this.#state(session);
      } catch (error) {
        await this.#remove(session);
        throw error;
      } finally {
        this.#unlock(session);
      }
    }),
  );

  /** Seal, verify, and return a trusted path. The caller imports it, then cancels in a finalizer. */
  readonly finish = Effect.fn("AttachmentUploads.finish")((owner: string, input: CompleteAttachmentUpload) =>
    attachmentCall(async (): Promise<string> => {
      const session = this.#require(owner, input.id);
      if (session.busy || session.sealed) throw new Error(sourceText("error.attachment.uploadBusy"));
      this.#lock(session);
      try {
        if (session.offset !== session.size) throw new Error(sourceText("error.attachment.uploadIncomplete"));
        if (session.digest.digest("hex") !== input.sha256) throw new Error(sourceText("error.attachment.uploadDigest"));
        await session.file.sync();
        await session.file.close();
        session.sealed = true;
        session.touched = Date.now();
        return session.path;
      } catch (error) {
        await this.#remove(session);
        throw error;
      } finally {
        this.#unlock(session);
      }
    }),
  );

  readonly cancel = Effect.fn("AttachmentUploads.cancel")((owner: string, id: string) =>
    attachmentCall(async () => {
      const session = this.#sessions.get(id);
      if (!session) return;
      if (session.owner !== owner) throw new Error(sourceText("error.attachment.uploadUnavailable"));
      if (session.busy) throw new Error(sourceText("error.attachment.uploadBusy"));
      await this.#remove(session);
    }),
  );

  readonly dispose = Effect.fn("AttachmentUploads.dispose")(() =>
    attachmentCall(async () => {
      this.#closing = true;
      for (const session of this.#sessions.values()) {
        await session.idle;
        if (this.#sessions.has(session.id)) await this.#remove(session);
      }
    }),
  );

  #lock(session: UploadSession): void {
    session.busy = true;
    session.idle = new Promise<void>((resolve) => {
      session.release = resolve;
    });
  }

  #unlock(session: UploadSession): void {
    session.busy = false;
    session.release?.();
    session.release = null;
  }

  #require(owner: string, id: string): UploadSession {
    const session = this.#sessions.get(id);
    if (!session || session.owner !== owner || Date.now() - session.touched > IDLE_MILLISECONDS)
      throw new Error(sourceText("error.attachment.uploadUnavailable"));
    return session;
  }

  #state(session: UploadSession): AttachmentUploadState {
    return { id: session.id, offset: session.offset, chunkBytes: ATTACHMENT_CHUNK_BYTES };
  }

  #initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/u.test(entry.name)) continue;
        const path = join(this.#directory, entry.name);
        // A crash can leave a partial file. Never touch unrelated files or recent directories.
        if (Date.now() - (await stat(path)).mtimeMs > 24 * 60 * 60 * 1_000)
          await rm(path, { recursive: true, force: true });
      }
    })().catch((error: unknown) => {
      // A user can repair permissions or free disk space before retrying an upload.
      this.#initialization = null;
      throw error;
    });
    return this.#initialization;
  }

  async #removeExpired(): Promise<void> {
    for (const session of this.#sessions.values()) {
      if (!session.busy && Date.now() - session.touched > IDLE_MILLISECONDS) await this.#remove(session);
    }
  }

  async #remove(session: UploadSession): Promise<void> {
    this.#sessions.delete(session.id);
    try {
      if (!session.sealed) await session.file.close();
    } finally {
      await rm(session.directory, { recursive: true, force: true });
    }
  }
}
