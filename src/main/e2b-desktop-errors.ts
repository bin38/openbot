import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";

const messages = {
  keyMissing: "error.e2b.keyMissing",
  keyUnreadable: "error.e2b.keyUnreadable",
  storeUnreadable: "error.e2b.storeUnreadable",
  storeWriteFailed: "error.e2b.storeWriteFailed",
  keyReplacement: "error.e2b.keyReplacement",
  keyInUse: "error.e2b.keyInUse",
  busy: "error.e2b.busy",
  agentMissing: "error.e2b.agentMissing",
  machineMissing: "error.e2b.machineMissing",
  machineExpired: "error.e2b.machineExpired",
  notRunning: "error.e2b.notRunning",
  humanControl: "error.e2b.humanControl",
  auth: "error.e2b.auth",
  rateLimit: "error.e2b.rateLimit",
  unavailable: "error.e2b.unavailable",
  filePath: "error.e2b.filePath",
  stream: "error.e2b.stream",
  viewerFailed: "error.e2b.viewerFailed",
  invalidTemplate: "error.e2b.invalidTemplate",
  creationPending: "error.e2b.creationPending",
  createCleanup: "error.e2b.createCleanup",
} as const;

/** SDK errors can contain credentials and URLs. Only this safe error crosses the service boundary. */
export class E2bFailure extends Schema.TaggedError<E2bFailure>()("E2bFailure", {
  code: Schema.String,
  message: Schema.String,
}) {}

export function e2bFailure(code: keyof typeof messages): E2bFailure {
  return new E2bFailure({ code, message: sourceText(messages[code]) });
}
