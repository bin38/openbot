import { type McpServerConfig, type McpTestResult, mcpConfigErrors, normalizeMcpConfig } from "@openbot/contracts/ipc";
import { type McpRegistryApi, type McpRegistryServer, registryMcpConfig } from "@openbot/contracts/ipc-mcp-registry";
import {
  Badge,
  Blocks,
  Button,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Text,
} from "@openbot/ui";
import { WizardDialog } from "@openbot/ui/features/settings/IntegrationLayout";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, For, onSettled, Show, untrack } from "solid-js";

export interface McpRegistryDialogProps {
  api: McpRegistryApi;
  onSave: (config: McpServerConfig) => Promise<void>;
  onTest: (config: McpServerConfig) => Promise<McpTestResult>;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}

/** Metadata is inert until the user reviews a connection and explicitly tests or saves it. */
export function McpRegistryDialog(props: McpRegistryDialogProps) {
  const { t, errorMessage } = useText();
  const api = createMemo(() => props.api);
  const [state, setState] = createStore<{
    query: string;
    searched: string;
    servers: McpRegistryServer[];
    cursor: string | null;
    stale: boolean;
    busy: boolean;
    error: string | null;
    selected: McpRegistryServer | null;
    connectionId: string;
    name: string;
    values: Record<string, string>;
    test: McpTestResult | null;
  }>({
    query: "",
    searched: "",
    servers: [],
    cursor: null,
    stale: false,
    busy: false,
    error: null,
    selected: null,
    connectionId: "",
    name: "",
    values: {},
    test: null,
  });
  let generation = 0;
  let alive = true;
  const connection = () => state.selected?.connections.find((entry) => entry.id === state.connectionId);
  const config = () => {
    const value = connection();
    return value ? normalizeMcpConfig(registryMcpConfig(state.name, value, state.values)) : null;
  };
  const ready = () => {
    const value = config();
    return Boolean(
      value &&
        Object.keys(mcpConfigErrors(value)).length === 0 &&
        connection()?.fields.every((field) => !field.required || state.values[`${field.target}:${field.name}`]?.trim()),
    );
  };
  async function search(more = false, refresh = false) {
    if (state.busy) return;
    const request = ++generation;
    const query = more ? state.searched : state.query.trim();
    const cursor = more ? state.cursor : null;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
      if (!more) {
        draft.servers = [];
        draft.cursor = null;
      }
    });
    try {
      const page = await untrack(api).search({ query, ...(cursor ? { cursor } : {}), refresh });
      if (!alive || request !== generation) return;
      setState((draft) => {
        const previous = more ? draft.servers : [];
        const seen = new Set(previous.map((server) => `${server.name}@${server.version}`));
        draft.servers = [
          ...previous,
          ...page.servers.filter((server) => !seen.has(`${server.name}@${server.version}`)),
        ];
        draft.cursor = page.nextCursor;
        draft.searched = query;
        draft.stale = page.stale;
      });
    } catch (error) {
      if (alive && request === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("error.mcp.registryUnavailable"));
        });
    } finally {
      if (alive && request === generation)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  onSettled(() => {
    void search();
    return () => {
      alive = false;
      generation += 1;
    };
  });
  function choose(server: McpRegistryServer) {
    setState((draft) => {
      draft.selected = server;
      draft.connectionId = server.connections[0]?.id ?? "";
      draft.name = (server.name.split("/").at(-1) ?? server.name).replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 64);
      draft.values = {};
      draft.test = null;
      draft.error = null;
    });
  }
  async function act(save: boolean) {
    const value = config();
    if (!value || !ready() || state.busy) return;
    const verified = state.test !== null && !state.test.error;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
      draft.test = null;
    });
    try {
      if (save) {
        await props.onSave({ ...value, enabled: verified });
        props.onClose();
      } else {
        const result = await props.onTest(value);
        if (alive)
          setState((draft) => {
            draft.test = result;
          });
      }
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("mcp.registry.failed"));
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }
  function close() {
    if (!state.busy) props.onClose();
  }
  return (
    <WizardDialog
      open
      nested
      wide
      closeLabel={t("common.close")}
      onClose={close}
      logo={<Blocks aria-hidden="true" />}
      title={t("mcp.registry.title")}
      description={t("mcp.registry.description")}
      onSubmit={() => {
        if (state.selected) void act(false);
        else void search();
      }}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={state.busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Show when={state.selected}>
            <Button type="button" disabled={state.busy || !ready()} onClick={() => void act(true)}>
              {state.test !== null && !state.test.error ? t("mcp.registry.save") : t("mcp.registry.saveDraft")}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={state.error}>
        {(error) => (
          <Text tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <Show
        when={state.selected}
        fallback={
          <>
            <Field label={t("mcp.registry.query")}>
              <Input
                type="search"
                value={state.query}
                disabled={state.busy}
                onValueChange={(query) =>
                  setState((draft) => {
                    draft.query = query;
                  })
                }
              />
            </Field>
            <ItemActions>
              <Button type="submit" disabled={state.busy} loading={state.busy}>
                {t("mcp.registry.search")}
              </Button>
              <Button type="button" variant="outline" disabled={state.busy} onClick={() => void search(false, true)}>
                {t("mcp.registry.refresh")}
              </Button>
            </ItemActions>
            <Show when={state.stale}>
              <Text tone="muted" variant="caption">
                {t("mcp.registry.cached")}
              </Text>
            </Show>
            <Show when={!state.busy && state.servers.length === 0}>
              <Text tone="muted">{t("mcp.registry.empty")}</Text>
            </Show>
            <ItemGroup>
              <For each={state.servers} keyed={(server) => `${server.name}@${server.version}`}>
                {(server) => (
                  <Item>
                    <ItemContent>
                      <ItemTitle>{server().title}</ItemTitle>
                      <ItemDescription>
                        {server().name} · {server().version}
                      </ItemDescription>
                      <Text variant="caption">{server().description}</Text>
                      <Show when={server().connections.length === 0}>
                        <ItemDescription>{t("mcp.registry.manual")}</ItemDescription>
                      </Show>
                    </ItemContent>
                    <ItemActions>
                      <Show when={server().websiteUrl}>
                        {(url) => (
                          <Button type="button" size="sm" variant="ghost" onClick={() => props.onOpenUrl(url())}>
                            {t("mcp.registry.website")}
                          </Button>
                        )}
                      </Show>
                      <Button
                        type="button"
                        size="sm"
                        disabled={state.busy || server().connections.length === 0}
                        onClick={() => choose(server())}
                      >
                        {t("mcp.registry.configure")}
                      </Button>
                    </ItemActions>
                  </Item>
                )}
              </For>
            </ItemGroup>
            <Show when={state.cursor}>
              <Button type="button" variant="outline" disabled={state.busy} onClick={() => void search(true)}>
                {t("mcp.registry.more")}
              </Button>
            </Show>
          </>
        }
      >
        {(server) => (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={state.busy}
              onClick={() =>
                setState((draft) => {
                  draft.selected = null;
                  draft.values = {};
                  draft.test = null;
                })
              }
            >
              {t("mcp.registry.back")}
            </Button>
            <ItemTitle>{server().title}</ItemTitle>
            <Text variant="caption">
              {server().name} · {server().version}
            </Text>
            <Field label={t("mcp.registry.name")}>
              <Input
                value={state.name}
                disabled={state.busy}
                onValueChange={(name) =>
                  setState((draft) => {
                    draft.name = name;
                    draft.test = null;
                  })
                }
              />
            </Field>
            <Field label={t("mcp.registry.method")}>
              <ItemActions>
                <For each={server().connections}>
                  {(entry) => (
                    <Button
                      type="button"
                      variant={state.connectionId === entry.id ? "default" : "outline"}
                      size="sm"
                      disabled={state.busy}
                      onClick={() =>
                        setState((draft) => {
                          draft.connectionId = entry.id;
                          draft.values = {};
                          draft.test = null;
                        })
                      }
                    >
                      {entry.transport === "http" ? "HTTP" : "STDIO"} · {entry.id}
                    </Button>
                  )}
                </For>
              </ItemActions>
            </Field>
            <Show when={connection()}>
              {(entry) => (
                <>
                  <Field label={entry().transport === "http" ? t("mcp.registry.address") : t("mcp.registry.command")}>
                    <Text>
                      {entry().transport === "http" ? entry().url : JSON.stringify([entry().command, ...entry().args])}
                    </Text>
                  </Field>
                  <Text variant="caption" tone="muted">
                    {t("mcp.registry.credentials")}
                  </Text>
                  <For each={entry().fields}>
                    {(field) => (
                      <Field
                        label={`${field.label} · ${field.target === "header" ? "HTTP" : "ENV"}`}
                        description={
                          field.target === "header"
                            ? `${field.description} ${t("mcp.registry.headerHint")}`
                            : field.description
                        }
                      >
                        <Badge variant="outline">
                          {field.required ? t("mcp.registry.required") : t("mcp.registry.optional")}
                        </Badge>
                        <Input
                          type={field.secret ? "password" : "text"}
                          autocomplete="off"
                          value={state.values[`${field.target}:${field.name}`] ?? ""}
                          disabled={state.busy}
                          onValueChange={(value) =>
                            setState((draft) => {
                              draft.values[`${field.target}:${field.name}`] = value;
                              draft.test = null;
                            })
                          }
                        />
                      </Field>
                    )}
                  </For>
                </>
              )}
            </Show>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy || !ready()}
              loading={state.busy}
              onClick={() => void act(false)}
            >
              {t("mcp.registry.test")}
            </Button>
            <Show when={state.test}>
              {(result) => (
                <Text role="status" tone={result().error ? "danger" : "muted"}>
                  {result().error ?? t("mcp.registry.testPassed", { count: result().toolCount })}
                </Text>
              )}
            </Show>
          </>
        )}
      </Show>
    </WizardDialog>
  );
}
