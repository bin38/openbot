import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApiChannelDefinition,
  ApiChannelOperation,
  ApiChannelRun,
  ApiChannelRunSummary,
  InvokeApiChannelInput,
  SaveApiChannelInput,
} from "@openbot/contracts/ipc";
import { Effect, Exit, Result, Semaphore } from "effect";
import type { GeneratedAttachmentSource } from "../backend/attachment-files";
import {
  type ApiChannelFetch,
  allowedApiArtifact,
  apiChannelValues,
  requestApiOperation,
  streamApiFile,
} from "./api-channel-http";
import { ApiChannelFailure, apiChannelFailure, apiValueAt, parseApiChannelDefinition } from "./api-channel-schema";
import type { ApiChannelStore, StoredApiRun } from "./api-channel-store";
import { apiChannelTemplates } from "./api-channel-templates";

const revision = (definition: ApiChannelDefinition) =>
  createHash("sha256").update(JSON.stringify(definition)).digest("hex");
const safeError = (error: unknown) => (error instanceof ApiChannelFailure ? error : apiChannelFailure("request"));
/** Owns outbound I/O and credentials. Agents can only name configured operations and local run IDs. */
export class ApiChannelService {
  #gates = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>();
  #activeCalls = new Set<string>();
  #lifetime = new AbortController();
  readonly fetch: ApiChannelFetch;
  constructor(
    readonly store: ApiChannelStore,
    readonly directory: string,
    fetch: ApiChannelFetch,
  ) {
    this.fetch = (url, init) =>
      fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, this.#lifetime.signal]) : this.#lifetime.signal,
      });
  }
  readonly close = () => Effect.sync(() => this.#lifetime.abort());
  readonly list = () => this.store.list();
  readonly templates = () => apiChannelTemplates();
  readonly validate = (definitionJson: string) => parseApiChannelDefinition(definitionJson);
  readonly save = (input: SaveApiChannelInput) => this.store.save(input);
  readonly delete = (id: string) => this.store.delete(id);
  readonly setEnabled = (id: string, enabled: boolean) =>
    Effect.try({ try: () => this.store.entry(id), catch: safeError }).pipe(
      Effect.flatMap((current) => this.store.save({ id, enabled, definitionJson: JSON.stringify(current.definition) })),
    );
  readonly createDraft = (_agentId: string, definitionJson: string) =>
    this.store.save({ definitionJson, enabled: false }, "agent");

  /** Local history reads never contact a configured service or retry an operation. */
  readonly listRuns = (channelId?: string): Effect.Effect<ApiChannelRunSummary[], ApiChannelFailure> =>
    Effect.try({
      try: () => {
        const channels = this.store.list();
        return this.store.recentRuns(channelId).map((record) => {
          const channel = channels.find((item) => item.id === record.result.channelId);
          const operation = channel?.definition.operations.find((item) => item.id === record.result.operationId);
          const result = this.#publicRun(record);
          return {
            id: result.id,
            channelId: result.channelId,
            channelName: channel?.definition.name ?? null,
            operationId: result.operationId,
            operationName: operation?.name.trim() ? operation.name : result.operationId,
            status: result.status,
            createdAt: recordedDate(record.createdAt),
            updatedAt: recordedDate(record.updatedAt),
            artifactCount: result.artifacts.length,
          };
        });
      },
      catch: safeError,
    });
  readonly readForUi = (id: string): Effect.Effect<ApiChannelRun, ApiChannelFailure> =>
    Effect.try({
      try: () => {
        const record = this.store.run(id);
        if (!record) throw apiChannelFailure("run");
        return this.#publicRun(record);
      },
      catch: safeError,
    });
  /** Local UI handlers use these wrappers; agent tools retain their owner argument. */
  readonly pollForUi = (id: string) =>
    Effect.try({
      try: () => {
        const record = this.store.run(id);
        if (!record) throw apiChannelFailure("run");
        return record.owner;
      },
      catch: safeError,
    }).pipe(Effect.flatMap((owner) => this.poll(owner, id)));
  readonly downloadForUi = <A, E>(
    artifactId: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ApiChannelFailure> =>
    Effect.try({
      try: () => {
        const found = this.store.artifact(artifactId);
        if (!found) throw apiChannelFailure("artifact");
        return found.run.owner;
      },
      catch: safeError,
    }).pipe(Effect.flatMap((owner) => this.download(owner, artifactId, consume)));

  #publicRun(record: StoredApiRun): ApiChannelRun {
    if (record.result.status === "pending" && !record.job && !this.#activeCalls.has(record.result.id)) {
      return { ...record.result, status: "unknown", message: apiChannelFailure("request").message };
    }
    return record.result;
  }

  readonly call = Effect.fn("ApiChannels.call")(function* (
    this: ApiChannelService,
    owner: string,
    input: InvokeApiChannelInput,
    files: ReadonlyMap<string, GeneratedAttachmentSource>,
    requestId: string,
  ) {
    const id = createHash("sha256").update(`${owner}\0${requestId}`).digest("hex");
    return yield* this.#gate(id).withPermit(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          this.#activeCalls.add(id);
        }),
        () =>
          Effect.gen({ self: this }, function* () {
            const previous = yield* Effect.try({ try: () => this.store.run(id), catch: safeError });
            if (previous) {
              if (previous.result.status === "pending" && !previous.job) {
                const result = {
                  ...previous.result,
                  status: "unknown" as const,
                  message: apiChannelFailure("request").message,
                };
                yield* this.store.putRun({ ...previous, result });
                return result;
              }
              return previous.result;
            }
            const { channel, operation, values, credential } = yield* Effect.try({
              try: () => {
                const channel = this.store.entry(input.channelId);
                const operation = channel.definition.operations.find((item) => item.id === input.operationId);
                if (!channel.enabled || !operation) throw apiChannelFailure("unavailable");
                const values = apiChannelValues(operation, input.valuesJson);
                for (const parameter of operation.parameters.filter((item) => item.type === "file")) {
                  if ((parameter.required || values[parameter.name] !== undefined) && !files.has(parameter.name))
                    throw apiChannelFailure("file");
                }
                return { channel, operation, values, credential: this.store.key(channel.id) };
              },
              catch: safeError,
            });
            let record: StoredApiRun = {
              owner,
              revision: revision(channel.definition),
              result: {
                id,
                channelId: channel.id,
                operationId: operation.id,
                status: "pending",
                output: null,
                artifacts: [],
                message: apiChannelFailure("pending").message,
              },
              job: null,
              artifacts: [],
            };
            yield* this.store.putRun(record);
            let settled = false;
            return yield* Effect.gen({ self: this }, function* () {
              const response = yield* Effect.result(
                requestApiOperation(
                  channel.definition,
                  operation,
                  values,
                  credential,
                  files,
                  join(this.directory, id),
                  this.fetch,
                ),
              );
              if (Result.isFailure(response))
                record.result = {
                  ...record.result,
                  status:
                    !operation.readOnly && ["request", "response"].includes(response.failure.kind ?? "")
                      ? "unknown"
                      : "failed",
                  message: response.failure.message,
                };
              else {
                const received = response.success;
                record = yield* Effect.try({ try: () => this.#result(record, operation, received), catch: safeError });
                if (operation.job) {
                  const task = apiValueAt(response.success.raw, operation.job.idPath);
                  if ((typeof task !== "string" || !task) && typeof task !== "number")
                    return yield* Effect.fail(apiChannelFailure("response"));
                  record.job = {
                    operationId: operation.job.pollOperationId,
                    parameter: operation.job.pollParameter,
                    value: task,
                  };
                  record.result = {
                    ...record.result,
                    status: "pending",
                    message: apiChannelFailure("pending").message,
                  };
                }
              }
              yield* this.store.putRun(record);
              settled = true;
              return record.result;
            }).pipe(
              Effect.onExit((exit) =>
                !settled && Exit.isFailure(exit)
                  ? this.store
                      .putRun({
                        ...record,
                        artifacts: [],
                        result: {
                          ...record.result,
                          artifacts: [],
                          status: "unknown",
                          message: apiChannelFailure("request").message,
                        },
                      })
                      .pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.ensuring(
                Effect.promise(async () => {
                  if (!settled || ["failed", "unknown"].includes(record.result.status))
                    await rm(join(this.directory, id), { recursive: true, force: true }).catch(() => undefined);
                }),
              ),
            );
          }),
        () =>
          Effect.sync(() => {
            this.#activeCalls.delete(id);
          }),
      ),
    );
  }).bind(this);

  readonly poll = Effect.fn("ApiChannels.poll")(function* (this: ApiChannelService, owner: string, id: string) {
    return yield* this.#gate(id).withPermit(
      Effect.gen({ self: this }, function* () {
        const { record, channel } = yield* Effect.try({
          try: () => {
            const record = this.store.run(id);
            if (!record || record.owner !== owner) throw apiChannelFailure("run");
            const channel = this.store.entry(record.result.channelId);
            if (revision(channel.definition) !== record.revision) throw apiChannelFailure("run");
            return { record, channel };
          },
          catch: safeError,
        });
        if (record.result.status === "pending" && !record.job) {
          const result = {
            ...record.result,
            status: "unknown" as const,
            message: apiChannelFailure("request").message,
          };
          yield* this.store.putRun({ ...record, result });
          return result;
        }
        if (record.result.status !== "pending" || !record.job) return record.result;
        if (!channel.enabled) return yield* Effect.fail(apiChannelFailure("unavailable"));
        const operation = channel.definition.operations.find((operation) => operation.id === record.job?.operationId);
        if (!operation?.readOnly) return yield* Effect.fail(apiChannelFailure("run"));
        const job = record.job;
        const parameter = operation.parameters.find((parameter) => parameter.name === job.parameter);
        const taskValue = parameter?.type === "string" ? String(job.value) : job.value;
        const values = yield* Effect.try({
          try: () => apiChannelValues(operation, JSON.stringify({ [job.parameter]: taskValue })),
          catch: safeError,
        });
        const credential = yield* Effect.try({ try: () => this.store.key(channel.id), catch: safeError });
        const pollDirectory = join(this.directory, id, randomUUID());
        let persisted = false;
        return yield* Effect.gen({ self: this }, function* () {
          const response = yield* Effect.result(
            requestApiOperation(
              channel.definition,
              operation,
              values,
              credential,
              new Map(),
              pollDirectory,
              this.fetch,
            ),
          );
          const cleanup = Effect.promise(() =>
            rm(pollDirectory, { recursive: true, force: true }).catch(() => undefined),
          );
          if (Result.isFailure(response)) yield* cleanup;
          const next = Result.isFailure(response)
            ? { ...record, result: { ...record.result, message: response.failure.message } }
            : yield* Effect.try({
                try: () => this.#result(record, operation, response.success),
                catch: safeError,
              }).pipe(Effect.onError(() => cleanup));
          yield* this.store
            .putRun(next)
            .pipe(
              Effect.onError(() =>
                Effect.promise(() => rm(pollDirectory, { recursive: true, force: true }).catch(() => undefined)),
              ),
            );
          persisted = true;
          return next.result;
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              if (!persisted) await rm(pollDirectory, { recursive: true, force: true }).catch(() => undefined);
            }),
          ),
        );
      }),
    );
  }).bind(this);

  #result(
    record: StoredApiRun,
    operation: ApiChannelOperation,
    response: Effect.Success<ReturnType<typeof requestApiOperation>>,
  ): StoredApiRun {
    const status = operation.response.statusPath ? String(apiValueAt(response.raw, operation.response.statusPath)) : "";
    if (
      operation.response.statusPath &&
      (apiValueAt(response.raw, operation.response.statusPath) === undefined ||
        typeof apiValueAt(response.raw, operation.response.statusPath) === "object")
    )
      throw apiChannelFailure("response");
    const state = operation.response.statusPath
      ? operation.response.successValues.includes(status)
        ? "completed"
        : operation.response.failureValues.includes(status)
          ? "failed"
          : "pending"
      : "completed";
    const artifacts = response.artifacts.map((artifact) => {
      const previous = artifact.url
        ? record.artifacts.find(
            (item) =>
              item.url === artifact.url && item.fileName === artifact.fileName && item.mimeType === artifact.mimeType,
          )
        : undefined;
      return previous ?? artifact;
    });
    return {
      ...record,
      artifacts,
      result: {
        ...record.result,
        status: state,
        output: response.output,
        outputTruncated: response.outputTruncated,
        artifacts: artifacts.map(({ id, fileName, mimeType }) => ({ id, fileName, mimeType })),
        message: state === "completed" ? null : apiChannelFailure(state === "pending" ? "pending" : "failed").message,
      },
    };
  }
  readonly download = <A, E>(
    owner: string,
    artifactId: string,
    consume: (source: GeneratedAttachmentSource) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ApiChannelFailure> =>
    this.#gate(artifactId).withPermit(
      Effect.gen({ self: this }, function* () {
        const found = yield* Effect.try({ try: () => this.store.artifact(artifactId), catch: safeError });
        if (!found || found.run.owner !== owner) return yield* Effect.fail(apiChannelFailure("artifact"));
        let path = found.artifact.path;
        if (!path) {
          const channel = yield* Effect.try({
            try: () => this.store.entry(found.run.result.channelId),
            catch: safeError,
          });
          if (revision(channel.definition) !== found.run.revision) return yield* Effect.fail(apiChannelFailure("run"));
          if (!channel.enabled) return yield* Effect.fail(apiChannelFailure("unavailable"));
          const url = found.artifact.url;
          if (!url || !allowedApiArtifact(url, channel.definition))
            return yield* Effect.fail(apiChannelFailure("artifact"));
          path = yield* Effect.tryPromise({
            try: async (interrupt) => {
              const signal = AbortSignal.any([interrupt, AbortSignal.timeout(120_000)]);
              // Deliberately no API auth and no cookies on a signed artifact/CDN URL.
              const response = await this.fetch(url, { signal, redirect: "manual", credentials: "omit" });
              if (!response.ok) {
                await response.body?.cancel();
                throw apiChannelFailure("artifact");
              }
              return streamApiFile(
                response,
                join(this.directory, found.run.result.id, randomUUID()),
                signal,
                found.artifact.fileName,
              );
            },
            catch: () => apiChannelFailure("artifact"),
          });
          const downloaded = path;
          yield* this.store
            .cacheArtifact(found.run.result.id, artifactId, downloaded)
            .pipe(Effect.onError(() => Effect.promise(() => rm(downloaded, { force: true }).catch(() => undefined))));
        }
        const safePath = path;
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({ try: () => open(safePath, "r"), catch: () => apiChannelFailure("artifact") }),
          (handle) => consume({ path: safePath, handle }),
          (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
        );
      }),
    );
  #gate(id: string) {
    let gate = this.#gates.get(id);
    if (!gate) {
      gate = Semaphore.makeUnsafe(1);
      this.#gates.set(id, gate);
    }
    return gate;
  }
}

function recordedDate(value: string | undefined): string | null {
  return value !== undefined && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
}
