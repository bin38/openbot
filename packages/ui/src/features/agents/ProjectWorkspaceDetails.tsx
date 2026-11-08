import type { ProjectWorkspaceContext } from "@openbot/contracts/ipc";
import { Field, Text } from "@openbot/ui";
import { createMemo, For, Show } from "solid-js";
import { useText } from "../../text";

/** File detection is descriptive. It does not enable a skill or change a project. */
export function ProjectWorkspaceDetails(props: {
  context: ProjectWorkspaceContext;
  sharedWith?: readonly string[] | undefined;
}) {
  const { t } = useText();
  const repository = createMemo(() => {
    const git = props.context.git;
    return git.status === "repository" ? git : undefined;
  });
  return (
    <div class="agent-session-setting-notes">
      <Text>{props.context.path}</Text>
      <Show when={!props.context.available}>
        <Text role="alert">{t("agent.project.unavailable")}</Text>
      </Show>
      <Show when={repository()}>
        {(git) => (
          <>
            <Field label={t("agent.project.gitRoot")}>
              <Text>{git().root}</Text>
            </Field>
            <Field label={t("agent.project.branch")}>
              <Text>{git().branch ?? t("agent.project.detached", { commit: git().commit?.slice(0, 12) ?? "" })}</Text>
            </Field>
            <Show when={git().worktree}>
              <Text tone="muted">{t("agent.project.worktree")}</Text>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.context.git.status === "none"}>
        <Text tone="muted">{t("agent.project.noGit")}</Text>
      </Show>
      <Show when={props.context.git.status === "unavailable"}>
        <Text tone="muted">{t("agent.project.gitUnavailable")}</Text>
      </Show>
      <Field label={t("agent.project.instructions")}>
        <Show
          when={props.context.instructions.length > 0}
          fallback={<Text tone="muted">{t("agent.project.noInstructions")}</Text>}
        >
          <ul>
            <For each={props.context.instructions}>
              {(file) => (
                <li>
                  <Text>{file.path}</Text>
                  <Show when={file.scope === "ancestor"}>
                    <Text tone="muted">{t("agent.project.ancestor")}</Text>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Field>
      <Field label={t("agent.project.skills")}>
        <Show when={props.context.skills.length > 0} fallback={<Text tone="muted">{t("agent.project.noSkills")}</Text>}>
          <ul>
            <For each={props.context.skills}>
              {(skill) => (
                <li>
                  <Text>{skill.slug}</Text>
                  <Text tone="muted">{skill.path}</Text>
                  <Show when={skill.scope === "ancestor"}>
                    <Text tone="muted">{t("agent.project.ancestor")}</Text>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Field>
      <Text tone="muted">{t("agent.project.detectionNote")}</Text>
      <Show when={props.context.truncated}>
        <Text tone="muted">{t("agent.project.truncated")}</Text>
      </Show>
      <Show when={(props.sharedWith?.length ?? 0) > 0}>
        <Text tone="muted">{t("agent.project.shared", { names: props.sharedWith?.join(", ") ?? "" })}</Text>
      </Show>
    </div>
  );
}
