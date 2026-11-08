import { isDynamicRecord } from "./runtime-values";

export type ColabLoginPhase = "idle" | "waiting-code" | "submitting" | "connected" | "error";

export interface ColabSession {
  name: string;
  hardware: string;
  shape: string;
  state: "idle" | "busy" | "unknown";
}

/** Local CLI metadata only. No OAuth code, runtime URL or bearer token crosses this boundary. */
export interface ColabSnapshot {
  installed: boolean;
  cliPath: string | null;
  version: string | null;
  credentialsPresent: boolean;
  connected: boolean;
  loginPhase: ColabLoginPhase;
  canOpenAuthorization: boolean;
  message: string | null;
  sessions: ColabSession[];
  unmanagedSessions: number;
  refreshedAt: number | null;
}

export interface ColabSessionInput {
  session: string;
}
export interface ColabLoginCodeInput {
  code: string;
}
export interface ColabCreateInput {
  name?: string | undefined;
}
export interface ColabExecuteInput extends ColabSessionInput {
  code: string;
  timeoutSeconds?: number | undefined;
}
export interface ColabFilesInput extends ColabSessionInput {
  path: string;
}
export interface ColabCommandResult {
  text: string;
  truncated: boolean;
}

export const COLAB_LIMITS = { name: 128, code: 64_000, path: 4_096, output: 1_048_576, timeoutSeconds: 300 } as const;

export function isColabSessionName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= COLAB_LIMITS.name &&
    !value.startsWith("-") &&
    value !== "?" &&
    !/[[\]|]|\p{Cc}/u.test(value)
  );
}

export function isColabSnapshot(value: unknown): value is ColabSnapshot {
  if (
    !isDynamicRecord(value) ||
    typeof value.installed !== "boolean" ||
    typeof value.credentialsPresent !== "boolean" ||
    typeof value.connected !== "boolean" ||
    typeof value.canOpenAuthorization !== "boolean" ||
    typeof value.loginPhase !== "string" ||
    !["idle", "waiting-code", "submitting", "connected", "error"].includes(value.loginPhase) ||
    (value.cliPath !== null && (typeof value.cliPath !== "string" || value.cliPath.length > 4_096)) ||
    (value.version !== null && (typeof value.version !== "string" || value.version.length > 128)) ||
    (value.message !== null && (typeof value.message !== "string" || value.message.length > 2_048)) ||
    typeof value.unmanagedSessions !== "number" ||
    !Number.isSafeInteger(value.unmanagedSessions) ||
    value.unmanagedSessions < 0 ||
    (value.refreshedAt !== null &&
      (typeof value.refreshedAt !== "number" || !Number.isSafeInteger(value.refreshedAt) || value.refreshedAt < 0)) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 256
  )
    return false;
  return (
    value.sessions.every(
      (row) =>
        isDynamicRecord(row) &&
        isColabSessionName(row.name) &&
        typeof row.hardware === "string" &&
        row.hardware.length <= 128 &&
        typeof row.shape === "string" &&
        row.shape.length <= 128 &&
        typeof row.state === "string" &&
        ["idle", "busy", "unknown"].includes(row.state) &&
        Object.keys(row).every((key) => ["name", "hardware", "shape", "state"].includes(key)),
    ) &&
    Object.keys(value).every((key) =>
      [
        "installed",
        "cliPath",
        "version",
        "credentialsPresent",
        "connected",
        "loginPhase",
        "canOpenAuthorization",
        "message",
        "sessions",
        "unmanagedSessions",
        "refreshedAt",
      ].includes(key),
    )
  );
}

export function isColabCommandResult(value: unknown): value is ColabCommandResult {
  return (
    isDynamicRecord(value) &&
    typeof value.text === "string" &&
    value.text.length <= COLAB_LIMITS.output + 1_024 &&
    typeof value.truncated === "boolean" &&
    Object.keys(value).every((key) => key === "text" || key === "truncated")
  );
}
