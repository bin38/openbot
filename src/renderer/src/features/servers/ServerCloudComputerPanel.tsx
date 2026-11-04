import type { E2bMachine, E2bSettings, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import {
  Button,
  ConfirmDialog,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  Spinner,
  Text,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, For, onSettled, Show } from "solid-js";

export interface ServerCloudComputerOptions {
  api: OpenBotDesktopApi["e2b"];
  listAgents: () => Promise<readonly { id: string; name: string }[]>;
}

/** This section is supplied only by the local desktop. Cloud credentials never reach a remote host. */
export function ServerCloudComputerPanel(props: ServerCloudComputerOptions) {
  const { t, errorMessage, format } = useText();
  const [state, setState] = createStore<{
    settings: E2bSettings | null;
    agents: readonly { id: string; name: string }[];
    selectedAgentId: string;
    template: string;
    timeoutMinutes: string;
    apiKey: string;
    busy: string | null;
    error: string | null;
    confirmation: "replace-key" | "clear-key" | "delete" | null;
    screenshot: { agentId: string; url: string } | null;
  }>({
    settings: null,
    agents: [],
    selectedAgentId: "",
    template: "desktop",
    timeoutMinutes: "15",
    apiKey: "",
    busy: "load",
    error: null,
    confirmation: null,
    screenshot: null,
  });

  let alive = true;
  const selected = () => state.settings?.machines.find((machine) => machine.agentId === state.selectedAgentId);
  const name = (id: string | undefined) => state.agents.find((agent) => agent.id === id)?.name ?? id ?? "";
  const ready = () => state.settings?.credentialStatus === "saved" && Boolean(state.selectedAgentId);
  const machineStatus = (machine: E2bMachine) => {
    if (machine.control === "human") return t("server.cloudComputer.humanControl");
    switch (machine.state) {
      case "running":
        return t("server.cloudComputer.running");
      case "paused":
        return t("server.cloudComputer.paused");
      case "missing":
        return t("server.cloudComputer.missing");
      case "unknown":
        return t("server.cloudComputer.unknown");
    }
  };
  async function run(key: string, operation: () => Promise<void>): Promise<boolean> {
    if (state.busy && state.busy !== "load") return false;
    setState((draft) => {
      draft.busy = key;
      draft.error = null;
    });
    try {
      await operation();
      return true;
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("server.cloudComputer.failed"));
        });
      return false;
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = null;
        });
    }
  }
  async function refreshSettings() {
    const settings = await props.api.getSettings();
    if (alive)
      setState((draft) => {
        draft.settings = settings;
      });
  }
  function load() {
    return run("load", async () => {
      const [settings, agents] = await Promise.all([props.api.getSettings(), props.listAgents()]);
      if (!alive) return;
      setState((draft) => {
        draft.settings = settings;
        draft.agents = agents;
        draft.template = settings.template;
        draft.timeoutMinutes = String(settings.timeoutMinutes);
        draft.selectedAgentId = agents[0]?.id ?? settings.machines[0]?.agentId ?? "";
      });
    });
  }
  onSettled(() => {
    void load();
    const onFocus = () => {
      if (!state.busy) void run("refresh", refreshSettings);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  });

  async function save(confirmKeyReplacement = false, clearApiKey = false) {
    const input = {
      template: state.template.trim(),
      timeoutMinutes: Number(state.timeoutMinutes),
      ...(!clearApiKey && state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
      confirmKeyReplacement,
      clearApiKey,
    };
    const saved = await run("save", async () => {
      const settings = await props.api.saveSettings(input);
      if (alive)
        setState((draft) => {
          draft.settings = settings;
          draft.apiKey = "";
        });
    });
    if (saved && alive)
      setState((draft) => {
        draft.confirmation = null;
      });
  }
  function requestSave() {
    if (
      state.apiKey.trim() &&
      state.settings &&
      (state.settings.machines.length || state.settings.pendingAgentIds.length) &&
      state.settings.credentialStatus !== "missing"
    ) {
      setState((draft) => {
        draft.confirmation = "replace-key";
      });
    } else void save();
  }
  async function action(kind: "start" | "pause" | "status" | "takeover" | "handback" | "delete") {
    const agentId = state.selectedAgentId;
    const done = await run(kind, async () => {
      await props.api[kind]({ agentId });
      await refreshSettings();
      if (alive)
        setState((draft) => {
          draft.screenshot = null;
        });
    });
    if (done && alive)
      setState((draft) => {
        draft.confirmation = null;
      });
  }
  async function screenshot() {
    const agentId = state.selectedAgentId;
    await run("screenshot", async () => {
      const result = await props.api.screenshot({ agentId });
      if (alive)
        setState((draft) => {
          draft.screenshot = { agentId, url: `data:${result.mimeType};base64,${result.base64}` };
        });
    });
  }

  return (
    <>
      <SettingsSection title={t("server.cloudComputer.connection")}>
        <Text variant="caption" tone="muted">
          {t("server.cloudComputer.description")}
        </Text>
        <Show when={state.error}>
          {(error) => (
            <Text tone="danger" role="alert">
              {error()}
            </Text>
          )}
        </Show>
        <Show when={state.busy === "load"}>
          <Spinner label={t("common.loading")} />
        </Show>
        <Show when={!state.settings && !state.busy}>
          <Button variant="outline" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </Show>
        <Show when={state.settings}>
          {(settings) => (
            <>
              <ItemGroup class="settings-modal-card">
                <Item>
                  <ItemContent>
                    <ItemTitle id="e2b-key-label">{t("server.cloudComputer.apiKey")}</ItemTitle>
                    <ItemDescription>
                      {settings().credentialStatus === "saved"
                        ? t("server.cloudComputer.keySaved")
                        : settings().credentialStatus === "unreadable"
                          ? t("server.cloudComputer.keyUnreadable")
                          : t("server.cloudComputer.keyMissing")}
                    </ItemDescription>
                    <Input
                      type="password"
                      aria-labelledby="e2b-key-label"
                      autocomplete="off"
                      value={state.apiKey}
                      disabled={Boolean(state.busy)}
                      onInput={(event) =>
                        setState((draft) => {
                          draft.apiKey = event.currentTarget.value;
                        })
                      }
                    />
                  </ItemContent>
                </Item>
                <Item>
                  <ItemContent>
                    <ItemTitle id="e2b-template-label">{t("server.cloudComputer.template")}</ItemTitle>
                    <ItemDescription>{t("server.cloudComputer.templateDescription")}</ItemDescription>
                    <Input
                      aria-labelledby="e2b-template-label"
                      value={state.template}
                      disabled={Boolean(state.busy)}
                      onInput={(event) =>
                        setState((draft) => {
                          draft.template = event.currentTarget.value;
                        })
                      }
                    />
                  </ItemContent>
                </Item>
                <Item>
                  <ItemContent>
                    <ItemTitle id="e2b-timeout-label">{t("server.cloudComputer.timeout")}</ItemTitle>
                    <ItemDescription>{t("server.cloudComputer.timeoutDescription")}</ItemDescription>
                    <Input
                      type="number"
                      min="1"
                      max="60"
                      step="1"
                      aria-labelledby="e2b-timeout-label"
                      value={state.timeoutMinutes}
                      disabled={Boolean(state.busy)}
                      onInput={(event) =>
                        setState((draft) => {
                          draft.timeoutMinutes = event.currentTarget.value;
                        })
                      }
                    />
                  </ItemContent>
                </Item>
                <Item>
                  <ItemContent>
                    <ItemDescription>{t("server.cloudComputer.privacy")}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button disabled={Boolean(state.busy)} loading={state.busy === "save"} onClick={requestSave}>
                      {t("common.save")}
                    </Button>
                    <Show when={settings().credentialStatus !== "missing"}>
                      <Button
                        variant="ghost"
                        disabled={Boolean(state.busy)}
                        onClick={() =>
                          setState((draft) => {
                            draft.confirmation = "clear-key";
                          })
                        }
                      >
                        {t("server.cloudComputer.clearKey")}
                      </Button>
                    </Show>
                  </ItemActions>
                </Item>
              </ItemGroup>
            </>
          )}
        </Show>
      </SettingsSection>
      <SettingsSection title={t("server.cloudComputer.machines")}>
        <ItemGroup class="settings-modal-card">
          <Item>
            <ItemContent>
              <ItemTitle id="e2b-agent-label">{t("server.cloudComputer.agent")}</ItemTitle>
              <Select<string>
                options={[
                  ...new Set([
                    ...state.agents.map((agent) => agent.id),
                    ...(state.settings?.machines.map((machine) => machine.agentId) ?? []),
                    ...(state.settings?.pendingAgentIds ?? []),
                  ]),
                ]}
                value={state.selectedAgentId || null}
                disabled={Boolean(state.busy)}
                onChange={(id) =>
                  setState((draft) => {
                    draft.selectedAgentId = id ?? "";
                    draft.screenshot = null;
                  })
                }
                itemComponent={(item) => <SelectItem item={item.item}>{name(item.item.rawValue)}</SelectItem>}
              >
                <SelectTrigger aria-labelledby="e2b-agent-label">
                  <SelectValue<string>>{(value) => name(value.selectedOption())}</SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
              <Show
                when={selected()}
                fallback={
                  <ItemDescription>
                    {state.settings?.pendingAgentIds.includes(state.selectedAgentId)
                      ? t("server.cloudComputer.pending")
                      : t("server.cloudComputer.noMachine")}
                  </ItemDescription>
                }
              >
                {(machine) => (
                  <>
                    <ItemDescription>{machineStatus(machine())}</ItemDescription>
                    <Text variant="caption" tone="muted">
                      {machine().sandboxId}
                    </Text>
                  </>
                )}
              </Show>
              <ItemDescription>{t("server.cloudComputer.runtimeNote")}</ItemDescription>
            </ItemContent>
          </Item>
          <Item>
            <ItemContent>
              <div class="server-settings-routine-feed-actions">
                <Button
                  disabled={!ready() || Boolean(state.busy) || selected()?.control === "human"}
                  loading={state.busy === "start"}
                  onClick={() => void action("start")}
                >
                  {selected() || state.settings?.pendingAgentIds.includes(state.selectedAgentId)
                    ? t("server.cloudComputer.resume")
                    : t("server.cloudComputer.create")}
                </Button>
                <Show when={selected()}>
                  <Button
                    variant="outline"
                    disabled={!ready() || Boolean(state.busy)}
                    onClick={() => void action("status")}
                  >
                    {t("server.cloudComputer.refresh")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!ready() || Boolean(state.busy) || selected()?.state !== "running"}
                    onClick={() => void screenshot()}
                  >
                    {t("server.cloudComputer.screenshot")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!ready() || Boolean(state.busy) || selected()?.state !== "running"}
                    onClick={() => void action("takeover")}
                  >
                    {t("server.cloudComputer.takeover")}
                  </Button>
                  <Show when={selected()?.control === "human"}>
                    <Button
                      variant="outline"
                      disabled={!ready() || Boolean(state.busy)}
                      onClick={() => void action("handback")}
                    >
                      {t("server.cloudComputer.handback")}
                    </Button>
                  </Show>
                  <Button
                    variant="outline"
                    disabled={!ready() || Boolean(state.busy)}
                    onClick={() => void action("pause")}
                  >
                    {t("server.cloudComputer.pause")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!ready() || Boolean(state.busy)}
                    onClick={() =>
                      setState((draft) => {
                        draft.confirmation = "delete";
                      })
                    }
                  >
                    {t("common.delete")}
                  </Button>
                </Show>
              </div>
            </ItemContent>
          </Item>
        </ItemGroup>
        <Show when={state.screenshot?.agentId === state.selectedAgentId && state.screenshot}>
          {(shot) => (
            <img
              src={shot().url}
              alt={t("server.cloudComputer.screenshotAlt")}
              class="server-cloud-computer-screenshot"
            />
          )}
        </Show>
        <Show when={state.settings?.machines.length}>
          <For each={state.settings?.machines}>
            {(machine) => (
              <Text variant="caption" tone="muted">
                {name(machine.agentId)} · {machineStatus(machine)} · {format.date(new Date(machine.updatedAt))}
              </Text>
            )}
          </For>
        </Show>
      </SettingsSection>
      <ConfirmDialog
        open={state.confirmation !== null}
        tone={state.confirmation === "replace-key" ? "default" : "destructive"}
        title={
          state.confirmation === "delete"
            ? t("server.cloudComputer.deleteTitle")
            : state.confirmation === "clear-key"
              ? t("server.cloudComputer.clearKey")
              : t("server.cloudComputer.replaceKey")
        }
        description={
          state.confirmation === "delete"
            ? t("server.cloudComputer.deleteDescription")
            : state.confirmation === "clear-key"
              ? t("server.cloudComputer.clearDescription")
              : t("server.cloudComputer.replaceDescription")
        }
        confirmLabel={state.confirmation === "delete" ? t("common.delete") : t("server.cloudComputer.confirm")}
        error={state.error}
        pending={Boolean(state.busy)}
        onCancel={() =>
          setState((draft) => {
            draft.confirmation = null;
          })
        }
        onConfirm={async () => {
          if (state.confirmation === "delete") await action("delete");
          else await save(true, state.confirmation === "clear-key");
        }}
      />
    </>
  );
}
