import type { InstalledSkill } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { conversationRuntime } from "../conversation-runtime";
import type { ConversationProps } from "../conversation-types";
import { installedSkillsRequestKey } from "../installed-skills-source";

export interface SkillsStoreDeps {
  props: ConversationProps;
  settingsOpen: () => boolean;
}

export function createSkillsStore(deps: SkillsStoreDeps) {
  const [installedSkills, setInstalledSkills] = createSignal<InstalledSkill[]>([]);
  const [installedSkillsLoadFailed, setInstalledSkillsLoadFailed] = createSignal(false);
  const [installedSkillsRetry, setInstalledSkillsRetry] = createSignal(0);
  let installedSkillsRequest = 0;
  let installedSkillsSourceId: string | undefined;
  let failedInstalledSkillsAttempt: { serverId: string; sourceId: string; connectionSequence: number } | undefined;
  const installedSkillsSource = createMemo(() =>
    installedSkillsRequestKey(deps.props.agent?.id, deps.props.server, deps.props.skillsMarketplaceOpen === true),
  );
  createEffect(
    () =>
      `${deps.props.server?.id ?? "local"}\0${deps.props.server?.connectionSequence ?? 0}\0${deps.props.agent?.id ?? ""}\0${deps.props.agent?.workspacePath ?? ""}`,
    (source) => {
      const [serverId = "", connectionSequenceText, agentId = "", workspacePath = ""] = source.split("\0");
      const failedAttempt = failedInstalledSkillsAttempt;
      if (
        failedAttempt?.serverId === serverId &&
        failedAttempt.sourceId === `${serverId}\0${agentId}\0${workspacePath}` &&
        failedAttempt.connectionSequence !== Number(connectionSequenceText)
      ) {
        setInstalledSkillsRetry((retry) => retry + 1);
      }
    },
  );
  const refreshKey = createMemo(() => ({
    source: installedSkillsSource(),
    retry: installedSkillsRetry(),
    activeTurnId: deps.props.activeTurnId ?? "",
    settingsOpen: deps.settingsOpen(),
    workspacePath: deps.props.agent?.workspacePath ?? "",
  }));
  createEffect(refreshKey, ({ source, workspacePath }) => {
    const request = ++installedSkillsRequest;
    const [serverId = "", agentId, support, visibility] = source.split("\0");
    if (!agentId) {
      installedSkillsSourceId = undefined;
      failedInstalledSkillsAttempt = undefined;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
      return;
    }
    const sourceId = `${serverId}\0${agentId}\0${workspacePath}`;
    if (installedSkillsSourceId !== sourceId) {
      installedSkillsSourceId = sourceId;
      failedInstalledSkillsAttempt = undefined;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
    }
    if (visibility === "hidden") return;
    if (support === "unsupported") {
      failedInstalledSkillsAttempt = undefined;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
      return;
    }
    const connectionSequence = untrack(() => deps.props.server?.connectionSequence) ?? 0;
    failedInstalledSkillsAttempt = undefined;
    void conversationRuntime(deps.props)
      .agent.listInstalledSkills(agentId)
      .then((skills) => {
        if (request !== installedSkillsRequest) return;
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills(skills);
        setInstalledSkillsLoadFailed(false);
      })
      .catch(() => {
        if (request !== installedSkillsRequest) return;
        failedInstalledSkillsAttempt = { serverId, sourceId, connectionSequence };
        setInstalledSkillsLoadFailed(true);
        // Preserve an already loaded same-agent, same-workspace catalog when a refresh fails.
      });
  });

  return {
    installedSkills,
    installedSkillsLoadFailed,
  };
}
