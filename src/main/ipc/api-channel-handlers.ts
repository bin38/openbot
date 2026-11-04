import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ApiChannelIdInput,
  ApiChannelListRunsInput,
  InvokeApiChannelInput,
  SaveApiChannelInput,
  SetApiChannelEnabledInput,
  ValidateApiChannelInput,
} from "@openbot/contracts/ipc";
import { Effect, Result, Schema } from "effect";
import { app, type BrowserWindow, dialog } from "electron";
import { type ApiChannelFailure, apiChannelFailure } from "../api-channel-schema";
import type { ApiChannelService } from "../api-channel-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const definitionJson = Schema.String.check(Schema.isMaxLength(512_000));
const optionalKey = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096)));
function input<S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new Error("Invalid API channel request.");
  }
}
const idSchema = Schema.Struct({ id });
const saveSchema = Schema.Struct({
  id: Schema.optionalKey(id),
  definitionJson,
  enabled: Schema.Boolean,
  apiKey: optionalKey,
  clearApiKey: Schema.optionalKey(Schema.Boolean),
});
const decodeApiChannelId = (value: unknown): ApiChannelIdInput => input(idSchema, value);
const decodeApiChannelListRuns = (value: unknown): ApiChannelListRunsInput =>
  input(Schema.Struct({ channelId: Schema.optionalKey(id) }), value);
const decodeSaveApiChannel = (value: unknown): SaveApiChannelInput => input(saveSchema, value);
const decodeValidateApiChannel = (value: unknown): ValidateApiChannelInput =>
  input(Schema.Struct({ definitionJson }), value);
const decodeSetApiChannelEnabled = (value: unknown): SetApiChannelEnabledInput =>
  input(Schema.Struct({ id, enabled: Schema.Boolean }), value);
const decodeInvokeApiChannel = (value: unknown): InvokeApiChannelInput =>
  input(
    Schema.Struct({
      channelId: id,
      operationId: id,
      valuesJson: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
    }),
    value,
  );
async function run<A>(effect: Effect.Effect<A, ApiChannelFailure>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}
export function apiChannelIpcHandlers(
  service: ApiChannelService,
  getMainWindow: () => BrowserWindow | null,
): Pick<IpcGroupHandlers, "apiChannels"> {
  return {
    apiChannels: {
      list: handler(() => service.list()),
      listRuns: payloadHandler(decodeApiChannelListRuns, ({ channelId }) => run(service.listRuns(channelId))),
      getRun: payloadHandler(decodeApiChannelId, ({ id }) => run(service.readForUi(id))),
      templates: handler(() => service.templates()),
      validate: payloadHandler(decodeValidateApiChannel, ({ definitionJson }) => service.validate(definitionJson)),
      save: payloadHandler(decodeSaveApiChannel, (input) => run(service.save(input))),
      setEnabled: payloadHandler(decodeSetApiChannelEnabled, ({ id, enabled }) => run(service.setEnabled(id, enabled))),
      delete: payloadHandler(decodeApiChannelId, ({ id }) => run(service.delete(id))),
      // UI callers cannot name an agent or open arbitrary local file paths. File uploads use the
      // agent tool path and its AttachmentGateway workspace checks.
      invoke: payloadHandler(decodeInvokeApiChannel, (input) =>
        run(service.call("ui", input, new Map(), randomUUID())),
      ),
      readRun: payloadHandler(decodeApiChannelId, ({ id }) => run(service.pollForUi(id))),
      saveArtifact: payloadHandler(decodeApiChannelId, ({ id }) =>
        run(
          service.downloadForUi(id, (source) =>
            Effect.tryPromise({
              try: async () => {
                const window = getMainWindow();
                const options = {
                  defaultPath: join(app.getPath("downloads"), basename(source.path)),
                  showsTagField: false,
                };
                const choice =
                  window && !window.isDestroyed()
                    ? await dialog.showSaveDialog(window, options)
                    : await dialog.showSaveDialog(options);
                if (choice.canceled || !choice.filePath) return;
                const temporary = join(dirname(choice.filePath), `.${basename(choice.filePath)}.${randomUUID()}.tmp`);
                const target = await open(temporary, "wx", 0o600);
                try {
                  try {
                    const buffer = Buffer.alloc(64 * 1024);
                    for (let position = 0; ; ) {
                      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
                      if (!bytesRead) break;
                      position += bytesRead;
                      let offset = 0;
                      while (offset < bytesRead) {
                        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset);
                        if (!bytesWritten) throw apiChannelFailure("artifact");
                        offset += bytesWritten;
                      }
                    }
                    await target.sync();
                  } finally {
                    await target.close();
                  }
                  await rename(temporary, choice.filePath);
                } finally {
                  await rm(temporary, { force: true });
                }
              },
              catch: () => apiChannelFailure("artifact"),
            }),
          ),
        ),
      ),
    },
  };
}
