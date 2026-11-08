import type { AgentWorkspaceInfo, ProjectWorkspaceContext, ProjectWorkspaceInfo } from "@openbot/contracts/ipc";
import { Button, Field, Input, Text } from "@openbot/ui";
import { SettingsLinkGroup } from "@openbot/ui/components/SettingsPanel";
import { ProjectWorkspaceDetails } from "@openbot/ui/features/agents/ProjectWorkspaceDetails";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onSettled, Show } from "solid-js";
import { projectWorkspacesPort } from "../../project-workspaces-port";
import { createScopeGuard } from "../../scope-lifetime";
import { useAgents } from "../agents/agents-context";
import { ProjectWorkspacePicker } from "../agents/ProjectWorkspacePicker";
import { useServers } from "../servers/servers-context";
import { agentWorkspacesPort } from "./agent-workspaces-port";

/** The current agent's local working folder. Switching keeps all old files in place. */
export function AgentWorkspaceSettings(props: { agentId: string; workspacePath: string; working: boolean }) {
  const { t, errorMessage } = useText();
  const { activeServerId } = useServers();
  const { agentList } = useAgents();
  const scopeIsCurrent = createScopeGuard();
  const [state, setState] = createStore<{
    info: AgentWorkspaceInfo | null;
    context: ProjectWorkspaceContext | null;
    selected: ProjectWorkspaceInfo | null;
    pending: boolean;
    error: string | null;
  }>({ info: null, context: null, selected: null, pending: true, error: null });
  let generation = 0;
  const current = (request: number, serverId: string, agentId: string) =>
    scopeIsCurrent() && request === generation && activeServerId() === serverId && props.agentId === agentId;
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
    const request = ++generation;
    const serverId = activeServerId();
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
      if (draft.info?.agentId !== agentId) {
        draft.info = null;
        draft.context = null;
        draft.selected = null;
      }
    });
    try {
      const info = await agentWorkspacesPort().get(agentId);
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.info = info;
          draft.context = null;
          draft.selected = null;
        });
      if (!current(request, serverId, agentId)) return;
      const context = await agentWorkspacesPort().inspect(agentId);
      if (!current(request, serverId, agentId)) return;
      const projects = await projectWorkspacesPort().list();
      if (current(request, serverId, agentId)) {
        const project = projects.find((entry) => entry.path === context.path);
        setState((draft) => {
          draft.context = context;
          draft.selected = project ? { ...project, context } : null;
        });
      }
    } catch (error) {
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.workspace.readFailed"));
        });
    } finally {
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.pending = false;
        });
    }
  }

  async function change(action: "reset" | ProjectWorkspaceInfo): Promise<void> {
    if (state.pending || props.working) return;
    if (action !== "reset" && action.path === (state.info?.path ?? props.workspacePath)) {
      setState((draft) => {
        draft.selected = action;
        draft.context = action.context;
      });
      return;
    }
    const agentId = props.agentId;
    const request = ++generation;
    const serverId = activeServerId();
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const info =
        action === "reset"
          ? await agentWorkspacesPort().reset(agentId)
          : await projectWorkspacesPort().assign({ agentId, projectId: action.id });
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.info = info;
          draft.selected = action === "reset" ? null : action;
          draft.context = action === "reset" ? null : action.context;
        });
      if (current(request, serverId, agentId)) await load(agentId);
    } catch (error) {
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.error = errorMessage(error, t("agentSettings.workspace.saveFailed"));
        });
    } finally {
      if (current(request, serverId, agentId))
        setState((draft) => {
          draft.pending = false;
        });
    }
  }

  async function open(location: "current" | "managed" | "shared"): Promise<void> {
    const agentId = props.agentId;
    const request = generation;
    const serverId = activeServerId();
    try {
      await agentWorkspacesPort().open({ agentId, location });
    } catch (error) {
      if (current(request, serverId, agentId))
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
        <ProjectWorkspacePicker
          serverId={activeServerId()}
          value={state.selected}
          disabled={state.pending || props.working}
          allowManaged={false}
          showDetails={false}
          onChange={async (project) => {
            if (project) await change(project);
            else
              setState((draft) => {
                draft.selected = null;
              });
          }}
        />
        <Show when={state.context}>
          {(context) => (
            <ProjectWorkspaceDetails
              context={context()}
              sharedWith={agentList()
                .filter((agent) => agent.id !== props.agentId && agent.workspacePath === context().path)
                .map((agent) => agent.name)}
            />
          )}
        </Show>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={state.pending}
          onClick={() => void load(props.agentId)}
        >
          {t("agentSettings.workspace.refresh")}
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
