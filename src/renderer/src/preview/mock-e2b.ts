import {
  E2B_DEFAULT_TEMPLATE,
  E2B_DEFAULT_TIMEOUT_MINUTES,
  type E2bMachine,
  type E2bSettings,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";

/** A stateful local preview. No key is retained and no cloud requests are sent. */
export function createMockE2b(): OpenBotDesktopApi["e2b"] {
  let settings: E2bSettings = {
    credentialStatus: "missing",
    template: E2B_DEFAULT_TEMPLATE,
    timeoutMinutes: E2B_DEFAULT_TIMEOUT_MINUTES,
    machines: [],
    pendingAgentIds: [],
  };
  const read = () => structuredClone(settings);
  const change = (agentId: string, state: E2bMachine["state"], control: E2bMachine["control"]) => {
    const previous = settings.machines.find((machine) => machine.agentId === agentId);
    const machine: E2bMachine = {
      agentId,
      sandboxId: previous?.sandboxId ?? `preview-${agentId}`,
      state,
      control,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    settings = { ...settings, machines: [...settings.machines.filter((item) => item.agentId !== agentId), machine] };
    return structuredClone(machine);
  };
  return {
    getSettings: async () => read(),
    saveSettings: async (input) => {
      settings = {
        ...settings,
        template: input.template,
        timeoutMinutes: input.timeoutMinutes,
        credentialStatus: input.clearApiKey ? "missing" : input.apiKey ? "saved" : settings.credentialStatus,
      };
      return read();
    },
    list: async () => read().machines,
    status: async ({ agentId }) => read().machines.find((machine) => machine.agentId === agentId) ?? null,
    start: async ({ agentId }) => change(agentId, "running", "agent"),
    pause: async ({ agentId }) => change(agentId, "paused", "agent"),
    delete: async ({ agentId }) => {
      settings = { ...settings, machines: settings.machines.filter((machine) => machine.agentId !== agentId) };
    },
    takeover: async ({ agentId }) => change(agentId, "running", "human"),
    setViewerBounds: async () => {},
    closeViewer: async ({ agentId }) => {
      const machine = settings.machines.find((entry) => entry.agentId === agentId);
      if (machine) change(agentId, machine.state, "agent");
    },
    handback: async ({ agentId }) => change(agentId, "running", "agent"),
    screenshot: async () => ({
      mimeType: "image/png",
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6xkAAAAASUVORK5CYII=",
    }),
    preview: async () => ({
      mimeType: "image/png",
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6xkAAAAASUVORK5CYII=",
    }),
  };
}
