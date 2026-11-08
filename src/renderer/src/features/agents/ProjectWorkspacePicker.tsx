import type { ProjectWorkspace, ProjectWorkspaceInfo } from "@openbot/contracts/ipc";
import { Button, Field, SearchSelect, Text } from "@openbot/ui";
import { ProjectWorkspaceDetails } from "@openbot/ui/features/agents/ProjectWorkspaceDetails";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onSettled, Show } from "solid-js";
import { projectWorkspacesPort } from "../../project-workspaces-port";
import { createScopeGuard } from "../../scope-lifetime";

/** A native selection or a remembered project; no folder is created or copied here. */
export function ProjectWorkspacePicker(props: {
  serverId: string;
  value: ProjectWorkspaceInfo | null;
  disabled?: boolean;
  allowManaged?: boolean;
  showDetails?: boolean;
  sharedWith?: readonly string[];
  onChange: (project: ProjectWorkspaceInfo | null) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t, errorMessage } = useText();
  const scopeIsCurrent = createScopeGuard();
  const [state, setState] = createStore<{
    projects: ProjectWorkspace[];
    pending: boolean;
    error: string | null;
    retryProjectId: string | null;
  }>({ projects: [], pending: false, error: null, retryProjectId: null });
  let generation = 0;
  const current = (request: number, serverId: string) =>
    scopeIsCurrent() && request === generation && props.serverId === serverId;
  onSettled(() => () => {
    generation += 1;
  });

  async function load(serverId: string): Promise<void> {
    const request = ++generation;
    setState((draft) => {
      draft.error = null;
      draft.pending = true;
      draft.retryProjectId = null;
    });
    try {
      const projects = await projectWorkspacesPort().list();
      if (current(request, serverId))
        setState((draft) => {
          draft.projects = projects;
        });
    } catch (error) {
      if (current(request, serverId))
        setState((draft) => {
          draft.error = errorMessage(error, t("agent.project.readFailed"));
        });
    } finally {
      if (current(request, serverId))
        setState((draft) => {
          draft.pending = false;
        });
    }
  }
  createEffect(
    () => props.serverId,
    (serverId) => {
      void load(serverId);
    },
  );

  async function select(action: "choose" | "inspect" | "forget", projectId?: string): Promise<void> {
    if (state.pending || props.disabled) return;
    const request = ++generation;
    const serverId = props.serverId;
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
      draft.retryProjectId = null;
    });
    props.onPendingChange?.(true);
    try {
      if (action === "forget") {
        if (!projectId) return;
        await projectWorkspacesPort().forget(projectId);
        if (!current(request, serverId)) return;
        if (props.value?.id === projectId) await props.onChange(null);
      } else {
        const project =
          action === "choose"
            ? await projectWorkspacesPort().choose()
            : projectId
              ? await projectWorkspacesPort().inspect(projectId)
              : null;
        if (!current(request, serverId)) return;
        if (project) await props.onChange(project);
      }
      if (!current(request, serverId)) return;
      const projects = await projectWorkspacesPort().list();
      if (current(request, serverId))
        setState((draft) => {
          draft.projects = projects;
        });
    } catch (error) {
      if (current(request, serverId))
        setState((draft) => {
          draft.error = errorMessage(error, t("agent.project.readFailed"));
          draft.retryProjectId = action === "inspect" ? (projectId ?? null) : null;
        });
    } finally {
      if (current(request, serverId)) {
        setState((draft) => {
          draft.pending = false;
        });
        props.onPendingChange?.(false);
      }
    }
  }

  return (
    <div class="agent-session-setting-notes">
      <Field label={t("agent.project.title")}>
        <Show when={props.allowManaged !== false}>
          <Button
            type="button"
            variant={props.value === null ? "default" : "outline"}
            size="sm"
            disabled={props.disabled || state.pending}
            onClick={() => void props.onChange(null)}
          >
            {t("agent.project.managed")}
          </Button>
        </Show>
        <Show when={state.projects.length > 0}>
          <SearchSelect<ProjectWorkspace>
            aria-label={t("agent.project.recent")}
            options={state.projects}
            value={props.value}
            label={(project) => project.name}
            optionValue={(project) => project.id}
            optionTextValue={(project) => `${project.name} ${project.path}`}
            itemContent={(project) => (
              <>
                <Text>{project.name}</Text>
                <Text tone="muted">{project.path}</Text>
              </>
            )}
            disabled={props.disabled || state.pending}
            onChange={(project) => void select("inspect", project.id)}
          >
            {props.value?.name ?? t("agent.project.recent")}
          </SearchSelect>
        </Show>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled || state.pending}
          onClick={() => void select("choose")}
        >
          {t("agent.project.browse")}
        </Button>
      </Field>
      <Show when={state.pending}>
        <Text role="status" tone="muted">
          {t("agent.project.loading")}
        </Text>
      </Show>
      <Show when={props.value}>
        {(project) => (
          <>
            <Show when={props.showDetails !== false}>
              <ProjectWorkspaceDetails context={project().context} sharedWith={props.sharedWith} />
            </Show>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled || state.pending}
              onClick={() => void select("inspect", project().id)}
            >
              {t("agent.project.refresh")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled || state.pending}
              onClick={() => void select("forget", project().id)}
            >
              {t("agent.project.forget")}
            </Button>
            <Text tone="muted">{t("agent.project.forgetNote")}</Text>
          </>
        )}
      </Show>
      <Show when={state.error}>
        {(error) => (
          <>
            <Text role="alert">{error()}</Text>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.disabled || state.pending}
              onClick={() =>
                void (state.retryProjectId ? select("inspect", state.retryProjectId) : load(props.serverId))
              }
            >
              {t("common.retry")}
            </Button>
          </>
        )}
      </Show>
    </div>
  );
}
