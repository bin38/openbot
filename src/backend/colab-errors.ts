import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";

const keys = {
  missing: "error.colab.missing",
  authRequired: "error.colab.authRequired",
  loginPending: "error.colab.loginPending",
  loginFailed: "error.colab.loginFailed",
  commandFailed: "error.colab.commandFailed",
  timeout: "error.colab.timeout",
  cancelled: "error.colab.cancelled",
  invalid: "error.colab.invalid",
  file: "error.colab.file",
  fileExists: "error.colab.fileExists",
  sessionMissing: "error.colab.sessionMissing",
  proxy: "error.colab.proxy",
  allocation: "error.colab.allocation",
  cacheUnsafe: "error.colab.cacheUnsafe",
} as const;

export class ColabFailure extends Schema.TaggedError<ColabFailure>()("ColabFailure", {
  code: Schema.String,
  message: Schema.String,
}) {}
export function colabFailure(code: keyof typeof keys): ColabFailure {
  return new ColabFailure({ code, message: sourceText(keys[code]) });
}
