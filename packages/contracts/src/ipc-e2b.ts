/** Local cloud-computer settings. Credentials and viewer URLs never cross this contract. */
export interface E2bSettings {
  credentialStatus: "saved" | "missing" | "unreadable";
  template: string;
  timeoutMinutes: number;
  machines: E2bMachine[];
  /** Creation requests whose response was interrupted. Start retries their original idempotency key. */
  pendingAgentIds: string[];
}

export interface E2bMachine {
  agentId: string;
  sandboxId: string;
  state: "running" | "paused" | "unknown" | "missing";
  control: "agent" | "human";
  createdAt: string;
  updatedAt: string;
}

export interface SaveE2bSettingsInput {
  template: string;
  timeoutMinutes: number;
  /** Omit or leave empty to keep the saved key. */
  apiKey?: string;
  clearApiKey?: boolean;
  /** Keeps every existing machine binding when the user changes accounts. */
  confirmKeyReplacement?: boolean;
}

export interface E2bAgentInput {
  agentId: string;
}

/** Bounds within the main renderer, in CSS pixels. No viewer URL crosses IPC. */
export interface E2bViewerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface E2bTakeoverInput extends E2bAgentInput {
  /** Omit to use the separate desktop window. */
  bounds?: E2bViewerBounds;
}

export interface E2bViewerBoundsInput extends E2bAgentInput {
  /** Hide the native view while a dialog covers the pane, without changing control. */
  bounds: E2bViewerBounds | null;
}

export interface E2bScreenshot {
  mimeType: "image/png";
  base64: string;
}

export type E2bDesktopInput =
  | { kind: "click"; x: number; y: number; button: "left" | "right" | "double" }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; direction: "up" | "down"; pixels: number };

export interface E2bCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface E2bFileResult {
  path: string;
  bytes: number;
}

export const E2B_DEFAULT_TEMPLATE = "desktop";
export const E2B_DEFAULT_TIMEOUT_MINUTES = 15;
export const E2B_MIN_TIMEOUT_MINUTES = 1;
export const E2B_MAX_TIMEOUT_MINUTES = 60;
export const E2B_MAX_COMMAND_TIMEOUT_MS = 120_000;
