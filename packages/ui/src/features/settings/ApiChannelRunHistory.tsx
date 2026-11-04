import type { ApiChannelRunSummary } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  RefreshCw,
  SettingsSection,
  Spinner,
  Text,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";

export interface ApiChannelRunHistoryProps {
  channelName: string | null;
  filtered: boolean;
  runs: ApiChannelRunSummary[];
  loading: boolean;
  openingId: string | null;
  error: string | null;
  onRefresh: () => void;
  onShowAll: () => void;
  onOpen: (run: ApiChannelRunSummary) => void;
}

const STATUS_KEYS = {
  completed: "apiChannels.run.completed",
  pending: "apiChannels.run.pending",
  failed: "apiChannels.run.failed",
  unknown: "apiChannels.run.unknown",
} as const satisfies Record<ApiChannelRunSummary["status"], AppTextKey>;

/** Display persisted task metadata. Opening this section does not poll a remote API. */
export function ApiChannelRunHistory(props: ApiChannelRunHistoryProps) {
  const { t, format } = useText();
  const channelName = (value: string | null) => value ?? t("apiChannels.history.removedChannel");
  const title = () =>
    props.filtered
      ? t("apiChannels.history.channelTitle", { name: channelName(props.channelName) })
      : t("apiChannels.history.title");
  return (
    <SettingsSection
      title={title()}
      actions={
        <ItemActions>
          <Show when={props.filtered}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.loading || props.openingId !== null}
              onClick={() => props.onShowAll()}
            >
              {t("apiChannels.history.showAll")}
            </Button>
          </Show>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || props.openingId !== null}
            onClick={() => props.onRefresh()}
          >
            <RefreshCw aria-hidden="true" />
            {t("apiChannels.history.refresh")}
          </Button>
        </ItemActions>
      }
    >
      <Text tone="muted">{t("apiChannels.history.description")}</Text>
      <Show when={props.error}>
        {(error) => (
          <Text tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <Show when={props.loading}>
        <Spinner />
      </Show>
      <Show
        when={props.runs.length > 0}
        fallback={
          <Show when={!props.loading && !props.error}>
            <Text tone="muted">{t("apiChannels.history.empty")}</Text>
          </Show>
        }
      >
        <ItemGroup>
          <For each={props.runs} keyed={(run) => run.id}>
            {(run) => (
              <Item>
                <ItemContent>
                  <ItemTitle>
                    {run().operationName}{" "}
                    <Badge variant={run().status === "completed" ? "success-light" : "secondary"}>
                      {t(STATUS_KEYS[run().status])}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription>
                    {channelName(run().channelName)}
                    {" · "}
                    {t("apiChannels.history.files", { count: run().artifactCount })}
                  </ItemDescription>
                  <ItemDescription>
                    {run().updatedAt
                      ? t("apiChannels.history.updated", { time: format.date(new Date(run().updatedAt ?? "")) })
                      : t("apiChannels.history.timeUnknown")}
                  </ItemDescription>
                  <Show when={run().status === "unknown"}>
                    <ItemDescription>{t("apiChannels.run.unknownHint")}</ItemDescription>
                  </Show>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={props.loading || props.openingId !== null}
                    loading={props.openingId === run().id}
                    aria-label={t("apiChannels.history.openLabel", { name: run().operationName })}
                    onClick={() => props.onOpen(run())}
                  >
                    {t("apiChannels.history.open")}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </Show>
    </SettingsSection>
  );
}
