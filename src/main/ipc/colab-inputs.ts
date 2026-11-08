import {
  COLAB_LIMITS,
  type ColabCreateInput,
  type ColabExecuteInput,
  type ColabFilesInput,
  type ColabLoginCodeInput,
  type ColabSessionInput,
  isColabSessionName,
} from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { colabFailure } from "../../backend/colab-errors";
import { isObject } from "./validation";

function object(value: unknown, keys: string[]): DynamicRecord {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) throw colabFailure("invalid");
  return value;
}

export function parseColabSession(value: unknown): ColabSessionInput {
  const input = object(value, ["session"]);
  if (!isColabSessionName(input.session)) throw colabFailure("invalid");
  return { session: input.session };
}

export function parseColabCode(value: unknown): ColabLoginCodeInput {
  const input = object(value, ["code"]);
  if (
    typeof input.code !== "string" ||
    input.code.trim().length < 8 ||
    input.code.length > 8_192 ||
    /\p{Cc}/u.test(input.code.trim())
  )
    throw colabFailure("invalid");
  return { code: input.code.trim() };
}

export function parseColabCreate(value: unknown): ColabCreateInput {
  const input = object(value, ["name"]);
  if (input.name === undefined || input.name === "") return {};
  if (!isColabSessionName(input.name)) throw colabFailure("invalid");
  return { name: input.name };
}

export function parseColabExecute(value: unknown): ColabExecuteInput {
  const input = object(value, ["session", "code", "timeoutSeconds"]);
  if (
    !isColabSessionName(input.session) ||
    typeof input.code !== "string" ||
    !input.code.trim() ||
    input.code.length > COLAB_LIMITS.code ||
    (input.timeoutSeconds !== undefined &&
      (typeof input.timeoutSeconds !== "number" ||
        !Number.isInteger(input.timeoutSeconds) ||
        input.timeoutSeconds < 1 ||
        input.timeoutSeconds > COLAB_LIMITS.timeoutSeconds))
  )
    throw colabFailure("invalid");
  return {
    session: input.session,
    code: input.code,
    ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
  };
}

export function parseColabFiles(value: unknown): ColabFilesInput {
  const input = object(value, ["session", "path"]);
  if (
    !isColabSessionName(input.session) ||
    typeof input.path !== "string" ||
    !input.path ||
    input.path.length > COLAB_LIMITS.path ||
    /\p{Cc}/u.test(input.path)
  )
    throw colabFailure("invalid");
  return { session: input.session, path: input.path };
}
