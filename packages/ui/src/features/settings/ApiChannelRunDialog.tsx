import type { ApiChannelOperation, ApiChannelRun, ApiChannelSummary } from "@openbot/contracts/ipc";
import {
  Badge,
  Button,
  Field,
  Globe2,
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
  Text,
  Textarea,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, For, onSettled, Show, untrack } from "solid-js";
import { WizardDialog } from "./IntegrationLayout";

export interface ApiChannelRunDialogProps {
  channel: ApiChannelSummary | null;
  /** A saved result opens in inspection mode, with no generation or request-editing controls. */
  initialRun?: ApiChannelRun | undefined;
  operationName?: string | undefined;
  onInvoke: (operationId: string, valuesJson: string) => Promise<ApiChannelRun>;
  onReadRun: (id: string) => Promise<ApiChannelRun>;
  onSaveArtifact: (id: string) => Promise<void>;
  onClose: (running: boolean) => void;
}

function initialValues(operation: ApiChannelOperation | undefined): string {
  if (!operation) return "{}";
  const rows = operation.parameters
    .filter((parameter) => parameter.type !== "file")
    .map((parameter) => {
      const fallback =
        parameter.type === "number"
          ? "0"
          : parameter.type === "boolean"
            ? "false"
            : parameter.type === "json"
              ? "null"
              : '""';
      return `  ${JSON.stringify(parameter.name)}: ${parameter.defaultJson || fallback}`;
    });
  return rows.length ? `{\n${rows.join(",\n")}\n}` : "{}";
}

/** Only an explicit Run action sends a request. Pending jobs are refreshed manually. */
export function ApiChannelRunDialog(props: ApiChannelRunDialogProps) {
  const { t, errorMessage, sourceText } = useText();
  const [popupMount, setPopupMount] = createSignal<HTMLElement | undefined>(undefined);
  const channel = untrack(() => props.channel);
  const initialRun = untrack(() => props.initialRun ?? null);
  const historyMode = initialRun !== null;
  const historyOperationName = untrack(() => props.operationName ?? initialRun?.operationId ?? "");
  const [state, setState] = createStore<{
    operationId: string;
    valuesJson: string;
    busy: boolean;
    artifactBusyId: string | null;
    error: string | null;
    result: ApiChannelRun | null;
  }>({
    operationId: initialRun?.operationId ?? channel?.definition.operations[0]?.id ?? "",
    valuesJson: initialValues(channel?.definition.operations[0]),
    busy: false,
    artifactBusyId: null,
    error: null,
    result: initialRun,
  });
  let alive = true;
  onSettled(() => () => {
    alive = false;
  });
  const operation = () => channel?.definition.operations.find((item) => item.id === state.operationId);
  const fileInputs = () => operation()?.parameters.some((parameter) => parameter.type === "file") ?? false;
  const busy = () => state.busy || state.artifactBusyId !== null;
  const host = channel ? new URL(channel.definition.baseUrl).host : "";
  const status = () => {
    switch (state.result?.status) {
      case "completed":
        return t("apiChannels.run.completed");
      case "pending":
        return t("apiChannels.run.pending");
      case "failed":
        return t("apiChannels.run.failed");
      case "unknown":
        return t("apiChannels.run.unknown");
      default:
        return "";
    }
  };

  async function run(refresh: boolean): Promise<void> {
    if (busy() || (!refresh && (historyMode || !operation() || fileInputs() || state.result?.status === "unknown")))
      return;
    const previous = state.result;
    if (refresh && !previous) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      const result =
        refresh && previous
          ? await props.onReadRun(previous.id)
          : await props.onInvoke(state.operationId, state.valuesJson);
      if (alive)
        setState((draft) => {
          draft.result = result;
        });
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("apiChannels.run.error"));
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }

  async function saveArtifact(id: string): Promise<void> {
    if (busy()) return;
    setState((draft) => {
      draft.artifactBusyId = id;
      draft.error = null;
    });
    try {
      await props.onSaveArtifact(id);
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("apiChannels.run.saveArtifactFailed"));
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.artifactBusyId = null;
        });
    }
  }
  function close(): void {
    if (state.artifactBusyId !== null) return;
    // The host keeps the request and saved run. This view must not consume its eventual result.
    alive = false;
    props.onClose(state.busy);
  }

  return (
    <WizardDialog
      open
      nested
      wide
      contentRef={setPopupMount}
      closeLabel={t(state.busy ? "apiChannels.run.returnToHistory" : "common.close")}
      closeDisabled={state.artifactBusyId !== null}
      dismissible={!busy()}
      onClose={close}
      logo={<Globe2 aria-hidden="true" />}
      title={t(historyMode ? "apiChannels.history.resultTitle" : "apiChannels.run.title")}
      description={historyMode ? t("apiChannels.history.detailHint") : t("apiChannels.run.description", { host })}
      onSubmit={() => void run(false)}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={state.artifactBusyId !== null} onClick={close}>
            {t(state.busy ? "apiChannels.run.returnToHistory" : "common.close")}
          </Button>
          <Show when={channel && (state.result?.status === "pending" || state.result?.status === "unknown")}>
            <Button type="button" variant="outline" disabled={busy()} onClick={() => void run(true)}>
              {t("apiChannels.run.refresh")}
            </Button>
          </Show>
          <Show when={!historyMode}>
            <Button
              type="submit"
              disabled={busy() || !operation() || fileInputs() || state.result?.status === "unknown"}
              loading={state.busy}
            >
              {t("apiChannels.run.execute")}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={state.busy}>
        <Text tone="muted" role="status">
          {t("apiChannels.run.backgroundHint")}
        </Text>
      </Show>
      <Show when={state.error}>
        {(error) => (
          <Text tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <Show when={historyMode}>
        <Text>{historyOperationName}</Text>
        <Show when={!channel}>
          <Text tone="muted" role="status">
            {t("apiChannels.history.removedHint")}
          </Text>
        </Show>
      </Show>
      <Show when={!historyMode}>
        <Field label={t("apiChannels.run.operation")}>
          <Select
            options={channel?.definition.operations.map((item) => item.id) ?? []}
            value={state.operationId}
            disabled={busy()}
            onChange={(operationId) => {
              if (!operationId) return;
              const selected = channel?.definition.operations.find((item) => item.id === operationId);
              setState((draft) => {
                draft.operationId = operationId;
                draft.valuesJson = initialValues(selected);
                draft.result = null;
                draft.error = null;
              });
            }}
            itemComponent={(item) => (
              <SelectItem item={item.item}>
                {channel?.definition.operations.find((entry) => entry.id === item.item.rawValue)?.name ??
                  item.item.rawValue}
              </SelectItem>
            )}
          >
            <SelectTrigger aria-label={t("apiChannels.run.operation")}>
              <SelectValue<string>>{() => operation()?.name ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent mount={popupMount()} />
          </Select>
        </Field>
        <Show when={operation()} keyed>
          {(selected) => (
            <>
              <Text tone="muted">{selected.description}</Text>
              <Text variant="caption">
                {selected.method} {selected.path}
              </Text>
              <ItemGroup>
                <For each={selected.parameters} keyed={(parameter) => parameter.name}>
                  {(parameter) => (
                    <Item>
                      <ItemContent>
                        <ItemTitle>
                          {parameter().name}{" "}
                          <Badge variant="outline">
                            {t(parameter().required ? "apiChannels.run.required" : "apiChannels.run.optional")}
                          </Badge>
                        </ItemTitle>
                        <ItemDescription>{parameter().description}</ItemDescription>
                      </ItemContent>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </>
          )}
        </Show>
        <Show
          when={fileInputs()}
          fallback={
            <Field label={t("apiChannels.run.values")}>
              <Textarea
                rows={8}
                spellcheck={false}
                value={state.valuesJson}
                disabled={busy()}
                onValueChange={(valuesJson) =>
                  setState((draft) => {
                    draft.valuesJson = valuesJson;
                  })
                }
              />
            </Field>
          }
        >
          <Text tone="muted" role="status">
            {t("apiChannels.run.fileOnly")}
          </Text>
        </Show>
      </Show>
      <Show when={state.result} keyed>
        {(result) => (
          <>
            <Text role="status" tone={result.status === "failed" ? "danger" : "muted"}>
              {status()}
            </Text>
            <Show when={result.status === "unknown"}>
              <Text role="status">{t("apiChannels.run.unknownHint")}</Text>
            </Show>
            <Show when={result.message}>{(message) => <Text>{sourceText(message())}</Text>}</Show>
            <Field label={t("apiChannels.run.output")}>
              <Textarea
                rows={10}
                readonly
                value={typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
              />
            </Field>
            <Show when={result.outputTruncated}>
              <Text role="status">{t("apiChannels.run.outputTruncated")}</Text>
            </Show>
            <Show when={result.artifacts.length > 0}>
              <Field label={t("apiChannels.run.artifacts")} description={t("apiChannels.run.artifactHint")}>
                <ItemGroup>
                  <For each={result.artifacts} keyed={(artifact) => artifact.id}>
                    {(artifact) => (
                      <Item>
                        <ItemContent>
                          <ItemTitle>{artifact().fileName}</ItemTitle>
                          <ItemDescription>{artifact().mimeType}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={t("apiChannels.run.saveArtifactLabel", { name: artifact().fileName })}
                            disabled={busy()}
                            loading={state.artifactBusyId === artifact().id}
                            onClick={() => void saveArtifact(artifact().id)}
                          >
                            {t("apiChannels.run.saveArtifact")}
                          </Button>
                        </ItemActions>
                      </Item>
                    )}
                  </For>
                </ItemGroup>
              </Field>
            </Show>
          </>
        )}
      </Show>
    </WizardDialog>
  );
}
