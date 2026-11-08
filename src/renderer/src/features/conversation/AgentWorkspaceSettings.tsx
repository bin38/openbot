import type { AgentWorkspaceInfo } from "@openbot/contracts/ipc";
import { Button, Field, Input, Text } from "@openbot/ui";
import { SettingsLinkGroup } from "@openbot/ui/components/SettingsPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onSettled, Show } from "solid-js";
import { agentWorkspacesPort } from "./agent-workspaces-port";

/** The current agent's local working folder. Switching keeps all old files in place. */
export function AgentWorkspaceSettings(props: { agentId: string; workspacePath: string; working: boolean }) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    info: AgentWorkspaceInfo | null;
    pending: boolean;
    error: string | null;
  }>({ info: null, pending: true, error: null });
  let generation = 0;
  createEffect(
    () => `${props.agentId}\0${props.workspacePath}`,
    (signature) => {
      void load(signature.slice(0, signature.indexOf("\0")));
    },
  );
  onSettled(() => () => {
    generation += 1;
  });

  async function load(agentId: string): Promise<void> {
    const current = ++generation;
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const info = await agentWorkspacesPort().get(agentId);
      if (current === generation)
        setState((draft) => {
          draft.info = info;
        });
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.workspace.readFailed"));
        });
    } finally {
      if (current === generation)
        setState((draft) => {
          draft.pending = false;
        });
    }
  }

  async function change(action: "choose" | "reset"): Promise<void> {
    if (state.pending || props.working) return;
    const agentId = props.agentId;
    const current = ++generation;
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const info = await agentWorkspacesPort()[action](agentId);
      if (info && current === generation)
        setState((draft) => {
          draft.info = info;
        });
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.workspace.saveFailed"));
        });
    } finally {
      if (current === generation)
        setState((draft) => {
          draft.pending = false;
        });
    }
  }

  async function open(location: "current" | "managed" | "shared"): Promise<void> {
    const agentId = props.agentId;
    const current = generation;
    try {
      await agentWorkspacesPort().open({ agentId, location });
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.workspace.openFailed"));
        });
    }
  }

  return (
    <SettingsLinkGroup inset class="agent-settings-runtime-rows" title={t("agentSettings.workspace.title")}>
      <div class="agent-session-setting-notes">
        <Text tone="muted">{t("agentSettings.workspace.description")}</Text>
        <Field label={t("agentSettings.workspace.current")}>
          <Input value={state.info?.path ?? props.workspacePath} readonly spellcheck={false} />
        </Field>
        <Text tone="muted">
          {state.info?.custom ? t("agentSettings.workspace.custom") : t("agentSettings.workspace.managed")}
        </Text>
        <Show when={state.info && !state.info.available}>
          <Text role="alert">{t("agentSettings.workspace.unavailable")}</Text>
        </Show>
        <Show when={props.working}>
          <Text tone="muted">{t("agentSettings.workspace.busy")}</Text>
        </Show>
        <Button
          variant="outline"
          size="sm"
          disabled={state.pending || props.working}
          onClick={() => void change("choose")}
        >
          {t("agentSettings.workspace.choose")}
        </Button>
        <Show when={state.info?.custom}>
          <Button
            variant="outline"
            size="sm"
            disabled={state.pending || props.working}
            onClick={() => void change("reset")}
          >
            {t("agentSettings.workspace.reset")}
          </Button>
          <Button variant="ghost" size="sm" disabled={state.pending} onClick={() => void open("managed")}>
            {t("agentSettings.workspace.openManaged")}
          </Button>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.pending || state.info?.available !== true}
          onClick={() => void open("current")}
        >
          {t("agentSettings.workspace.open")}
        </Button>
        <Button variant="ghost" size="sm" disabled={state.pending} onClick={() => void open("shared")}>
          {t("agentSettings.workspace.openShared")}
        </Button>
        <Text tone="muted">{t("agentSettings.workspace.keepFiles")}</Text>
        <Show when={state.error}>{(error) => <Text role="alert">{error()}</Text>}</Show>
        <Show when={state.error && !state.info}>
          <Button variant="outline" size="sm" onClick={() => void load(props.agentId)}>
            {t("common.retry")}
          </Button>
        </Show>
      </div>
    </SettingsLinkGroup>
  );
}
