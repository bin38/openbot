import type {
  ApiChannelDefinition,
  ApiChannelRun,
  ApiChannelRunSummary,
  ApiChannelSummary,
  ApiChannelTemplate,
  OpenBotDesktopApi,
  SaveApiChannelInput,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  ConfirmDialog,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Plus,
  RefreshCw,
  SettingsSection,
  Spinner,
  Switch,
  Text,
} from "@openbot/ui";
import { ApiChannelEditor } from "@openbot/ui/features/settings/ApiChannelEditor";
import { ApiChannelRunDialog } from "@openbot/ui/features/settings/ApiChannelRunDialog";
import { ApiChannelRunHistory } from "@openbot/ui/features/settings/ApiChannelRunHistory";
import { useText } from "@openbot/ui/text";
import { createStore, For, onSettled, Show, untrack } from "solid-js";

export interface ServerApiChannelsOptions {
  api: OpenBotDesktopApi["apiChannels"];
}

const CREDENTIAL_LABEL = {
  saved: "apiChannels.credential.saved",
  missing: "apiChannels.credential.missing",
  unreadable: "apiChannels.credential.unreadable",
  "not-required": "apiChannels.credential.notRequired",
} as const satisfies Record<ApiChannelSummary["credentialStatus"], AppTextKey>;

interface EditorState {
  existing: ApiChannelSummary | null;
  definition: ApiChannelDefinition;
}
interface RunnerState {
  channel: ApiChannelSummary | null;
  initialRun?: ApiChannelRun;
  operationName?: string;
}

/** Native-only endpoint configuration. Opening the page never invokes a configured service. */
export function ServerApiChannelsPanel(props: ServerApiChannelsOptions) {
  const { t, errorMessage, format } = useText();
  const api = untrack(() => props.api);
  const [state, setState] = createStore<{
    channels: ApiChannelSummary[];
    templates: ApiChannelTemplate[];
    busy: string | null;
    error: string | null;
    editor: EditorState | null;
    runner: RunnerState | null;
    removing: ApiChannelSummary | null;
    historyChannelId: string | null;
    historyRuns: ApiChannelRunSummary[];
    historyLoading: boolean;
    historyOpeningId: string | null;
    historyError: string | null;
  }>({
    channels: [],
    templates: [],
    busy: "load",
    error: null,
    editor: null,
    runner: null,
    removing: null,
    historyChannelId: null,
    historyRuns: [],
    historyLoading: false,
    historyOpeningId: null,
    historyError: null,
  });
  let alive = true;
  let generation = 0;
  let historyGeneration = 0;

  async function loadHistory(): Promise<void> {
    const request = ++historyGeneration;
    const channelId = state.historyChannelId;
    setState((draft) => {
      draft.historyLoading = true;
      draft.historyError = null;
    });
    try {
      const runs = await api.listRuns(channelId ? { channelId } : {});
      if (alive && request === historyGeneration)
        setState((draft) => {
          draft.historyRuns = runs;
        });
    } catch (error) {
      if (alive && request === historyGeneration)
        setState((draft) => {
          draft.historyError = errorMessage(error, t("apiChannels.history.loadFailed"));
        });
    } finally {
      if (alive && request === historyGeneration)
        setState((draft) => {
          draft.historyLoading = false;
        });
    }
  }

  function showHistory(channelId: string | null): void {
    setState((draft) => {
      draft.historyChannelId = channelId;
    });
    void loadHistory();
  }

  async function openHistoryRun(summary: ApiChannelRunSummary): Promise<void> {
    if (state.busy || state.editor || state.runner || state.removing) return;
    setState((draft) => {
      draft.busy = "history";
      draft.historyOpeningId = summary.id;
      draft.historyError = null;
    });
    try {
      // Reading stored detail is local-only. The dialog polls only after an explicit Refresh press.
      const result = await api.getRun({ id: summary.id });
      if (alive)
        setState((draft) => {
          draft.runner = {
            channel: draft.channels.find((channel) => channel.id === result.channelId) ?? null,
            initialRun: result,
            operationName: summary.operationName,
          };
        });
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.historyError = errorMessage(error, t("apiChannels.history.loadFailed"));
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = null;
          draft.historyOpeningId = null;
        });
    }
  }

  async function load(): Promise<void> {
    const request = ++generation;
    setState((draft) => {
      draft.busy = "load";
      draft.error = null;
    });
    try {
      const [channels, templates] = await Promise.all([api.list(), api.templates()]);
      if (alive && request === generation)
        setState((draft) => {
          draft.channels = channels;
          draft.templates = templates;
        });
    } catch (error) {
      if (alive && request === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("apiChannels.loadFailed"));
        });
    } finally {
      if (alive && request === generation)
        setState((draft) => {
          draft.busy = null;
        });
    }
  }

  function replaceChannel(channel: ApiChannelSummary): void {
    setState((draft) => {
      const index = draft.channels.findIndex((item) => item.id === channel.id);
      if (index < 0) draft.channels.push(channel);
      else draft.channels[index] = channel;
    });
  }

  async function save(input: SaveApiChannelInput): Promise<void> {
    const channel = await api.save(input);
    if (!alive) return;
    // The durable save is the result. A later list failure must not invite a duplicate retry.
    replaceChannel(channel);
    setState((draft) => {
      draft.editor = null;
      draft.error = null;
    });
    void loadHistory();
  }

  async function setEnabled(channel: ApiChannelSummary, enabled: boolean): Promise<void> {
    if (state.busy) return;
    setState((draft) => {
      draft.busy = channel.id;
      draft.error = null;
    });
    try {
      const updated = await api.setEnabled({ id: channel.id, enabled });
      if (alive) replaceChannel(updated);
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("apiChannels.actionFailed"));
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = null;
        });
    }
  }

  async function remove(channel: ApiChannelSummary): Promise<void> {
    if (state.busy) return;
    setState((draft) => {
      draft.busy = channel.id;
      draft.error = null;
    });
    try {
      await api.delete({ id: channel.id });
      if (alive)
        setState((draft) => {
          draft.channels = draft.channels.filter((item) => item.id !== channel.id);
          draft.removing = null;
        });
      if (alive) void loadHistory();
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("apiChannels.actionFailed"));
          draft.removing = null;
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = null;
        });
    }
  }

  function add(): void {
    const definition: ApiChannelDefinition = {
      name: "",
      description: "",
      baseUrl: "",
      auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
      headers: [],
      artifactHosts: [],
      operations: [
        {
          id: "request",
          name: t("apiChannels.editor.exampleName"),
          description: "",
          method: "POST",
          path: "/",
          bodyType: "json",
          body: JSON.stringify({ input: "{{input}}" }, null, 2),
          query: [],
          parameters: [{ name: "input", type: "string", required: true, description: "", defaultJson: '""' }],
          readOnly: false,
          response: {
            format: "json",
            resultPath: "",
            errorPath: "",
            okValues: [],
            fileName: "response.json",
            mimeType: "application/json",
            artifacts: [],
            statusPath: "",
            successValues: [],
            failureValues: [],
          },
          job: null,
        },
      ],
    };
    setState((draft) => {
      draft.editor = { existing: null, definition };
    });
  }

  onSettled(() => {
    void load();
    void loadHistory();
    const focus = () => {
      if (!state.busy && !state.editor && !state.runner && !state.removing) {
        void load();
        void loadHistory();
      }
    };
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      generation += 1;
      historyGeneration += 1;
      window.removeEventListener("focus", focus);
    };
  });

  return (
    <>
      <Show when={state.error}>
        {(error) => (
          <Text tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <SettingsSection
        title={t("apiChannels.channels.title")}
        actions={
          <ItemActions>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(state.busy)}
              onClick={() => void load()}
              aria-label={t("apiChannels.refresh")}
            >
              <RefreshCw aria-hidden="true" />
              {t("apiChannels.refresh")}
            </Button>
            <Button type="button" size="sm" disabled={Boolean(state.busy)} onClick={add}>
              <Plus aria-hidden="true" />
              {t("apiChannels.add")}
            </Button>
          </ItemActions>
        }
      >
        <Show when={state.busy === "load"}>
          <Spinner />
        </Show>
        <Show when={state.channels.length > 0} fallback={<Text tone="muted">{t("apiChannels.empty")}</Text>}>
          <ItemGroup>
            <For each={state.channels} keyed={(channel) => channel.id}>
              {(channel) => (
                <Item>
                  <ItemContent>
                    <ItemTitle>
                      {channel().definition.name}{" "}
                      <Badge variant={channel().enabled ? "success-light" : "secondary"}>
                        {t(channel().enabled ? "apiChannels.enabled" : "apiChannels.disabled")}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription>{channel().definition.description}</ItemDescription>
                    <ItemDescription>{channel().definition.baseUrl}</ItemDescription>
                    <ItemDescription>
                      {t("apiChannels.operations", { count: channel().definition.operations.length })}
                      {" · "}
                      {t(CREDENTIAL_LABEL[channel().credentialStatus])}
                    </ItemDescription>
                    <Show when={channel().source === "agent"}>
                      <ItemDescription>
                        <Badge variant="outline">{t("apiChannels.agentDraft")}</Badge>
                      </ItemDescription>
                    </Show>
                    <ItemDescription>
                      {t("apiChannels.updated", { time: format.date(new Date(channel().updatedAt)) })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      checked={channel().enabled}
                      disabled={Boolean(state.busy)}
                      aria-label={t("apiChannels.enableLabel", { name: channel().definition.name })}
                      onChange={(enabled) => void setEnabled(channel(), enabled)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(state.busy)}
                      aria-label={t(
                        channel().source === "agent" && !channel().enabled
                          ? "apiChannels.completeDraft"
                          : "apiChannels.edit",
                        { name: channel().definition.name },
                      )}
                      onClick={() =>
                        setState((draft) => {
                          draft.editor = { existing: channel(), definition: channel().definition };
                        })
                      }
                    >
                      {t(
                        channel().source === "agent" && !channel().enabled
                          ? "apiChannels.reviewAction"
                          : "apiChannels.editAction",
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(state.busy) || !channel().enabled}
                      aria-label={t("apiChannels.run.open", { name: channel().definition.name })}
                      onClick={() =>
                        setState((draft) => {
                          draft.runner = { channel: channel() };
                        })
                      }
                    >
                      {t("apiChannels.run.action")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(state.busy) || state.historyLoading}
                      aria-label={t("apiChannels.history.channelOpen", { name: channel().definition.name })}
                      onClick={() => showHistory(channel().id)}
                    >
                      {t("apiChannels.history.channelAction")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(state.busy)}
                      aria-label={t("apiChannels.delete", { name: channel().definition.name })}
                      onClick={() =>
                        setState((draft) => {
                          draft.removing = channel();
                        })
                      }
                    >
                      {t("apiChannels.deleteAction")}
                    </Button>
                  </ItemActions>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>
      </SettingsSection>
      <ApiChannelRunHistory
        channelName={state.channels.find((channel) => channel.id === state.historyChannelId)?.definition.name ?? null}
        filtered={state.historyChannelId !== null}
        runs={state.historyRuns}
        loading={state.historyLoading}
        openingId={state.historyOpeningId}
        error={state.historyError}
        onRefresh={() => void loadHistory()}
        onShowAll={() => showHistory(null)}
        onOpen={(run) => void openHistoryRun(run)}
      />
      <SettingsSection title={t("apiChannels.template.title")}>
        <Text tone="muted">{t("apiChannels.template.description")}</Text>
        <ItemGroup>
          <For each={state.templates} keyed={(template) => template.id}>
            {(template) => (
              <Item>
                <ItemContent>
                  <ItemTitle>{template().name}</ItemTitle>
                  <ItemDescription>{template().description}</ItemDescription>
                  <ItemDescription>
                    {t("apiChannels.operations", { count: template().definition.operations.length })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={Boolean(state.busy)}
                    onClick={() =>
                      setState((draft) => {
                        draft.editor = { existing: null, definition: template().definition };
                      })
                    }
                  >
                    {t("apiChannels.template.use", { name: template().name })}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <Show when={state.editor} keyed>
        {(editor) => (
          <ApiChannelEditor
            definition={editor.definition}
            existing={editor.existing}
            onValidate={(definitionJson) => api.validate({ definitionJson })}
            onSave={save}
            onClose={() =>
              setState((draft) => {
                draft.editor = null;
              })
            }
          />
        )}
      </Show>
      <Show when={state.runner} keyed>
        {(runner) => (
          <ApiChannelRunDialog
            channel={runner.channel}
            initialRun={runner.initialRun}
            operationName={runner.operationName}
            onInvoke={async (operationId, valuesJson) => {
              if (!runner.channel) throw new Error(t("apiChannels.run.error"));
              try {
                return await api.invoke({ channelId: runner.channel.id, operationId, valuesJson });
              } finally {
                // Closing or replacing the dialog does not cancel the host request or reopen its view.
                if (alive) void loadHistory();
              }
            }}
            onReadRun={async (id) => {
              try {
                return await api.readRun({ id });
              } finally {
                if (alive) void loadHistory();
              }
            }}
            onSaveArtifact={(id) => api.saveArtifact({ id })}
            onClose={(running) => {
              setState((draft) => {
                if (running && runner.channel) draft.historyChannelId = runner.channel.id;
                draft.runner = null;
              });
              void loadHistory();
            }}
          />
        )}
      </Show>
      <Show when={state.removing} keyed>
        {(channel) => (
          <ConfirmDialog
            open
            title={t("apiChannels.delete.title")}
            description={t("apiChannels.delete.description", { name: channel.definition.name })}
            confirmLabel={t("apiChannels.delete.confirm")}
            tone="destructive"
            initialFocus="cancel"
            pending={state.busy === channel.id}
            onConfirm={() => remove(channel)}
            onCancel={() =>
              setState((draft) => {
                draft.removing = null;
              })
            }
          />
        )}
      </Show>
    </>
  );
}
