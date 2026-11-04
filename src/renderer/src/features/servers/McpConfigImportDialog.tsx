import type { McpServerConfig } from "@openbot/contracts/ipc";
import {
  Badge,
  Blocks,
  Button,
  Checkbox,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Text,
  Upload,
} from "@openbot/ui";
import { WizardDialog } from "@openbot/ui/features/settings/IntegrationLayout";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, For, onSettled, Show } from "solid-js";
import {
  MCP_IMPORT_MAX_BYTES,
  type McpImportIssue,
  type McpImportItem,
  mcpImportDestination,
  parseMcpConfigImport,
} from "./mcp-config-import";
import { normalizeMcpConfig } from "./mcp-servers";

interface McpConfigImportDialogProps {
  servers: McpServerConfig[];
  disabled: boolean;
  onReview: (configs: McpServerConfig[]) => void;
  onClose: () => void;
}

interface ImportState {
  source: string;
  reading: boolean;
  items: McpImportItem[];
  selected: number[];
  issue: McpImportIssue | "mcp.import.readFailed" | null;
}

/** Import is a local preview. Only the existing server form can connect or save these drafts. */
export function McpConfigImportDialog(props: McpConfigImportDialogProps) {
  const { t } = useText();
  const [state, setState] = createStore<ImportState>({
    source: "",
    reading: false,
    items: [],
    selected: [],
    issue: null,
  });
  let fileInput: HTMLInputElement | undefined;
  let readRun = 0;
  onSettled(() => () => {
    readRun += 1;
  });
  const selected = createMemo(() =>
    state.items.flatMap((item) => (item.config && state.selected.includes(item.index) ? [item.config] : [])),
  );
  const busy = () => state.reading || props.disabled;

  function preview(text: string): void {
    const result = parseMcpConfigImport(text);
    setState((current) => {
      current.source = "";
      current.reading = false;
      current.items = result.items;
      current.selected = result.items.flatMap((item) => (item.config ? [item.index] : []));
      current.issue = result.issue;
    });
  }

  async function readFile(file: File | undefined): Promise<void> {
    if (!file || props.disabled) return;
    const run = ++readRun;
    setState((current) => {
      current.source = "";
      current.items = [];
      current.selected = [];
      current.issue = file.size > MCP_IMPORT_MAX_BYTES ? "mcp.import.tooLarge" : null;
      current.reading = file.size <= MCP_IMPORT_MAX_BYTES;
    });
    if (file.size > MCP_IMPORT_MAX_BYTES) return;
    try {
      const text = await file.text();
      if (run === readRun) preview(text);
    } catch {
      if (run !== readRun) return;
      setState((current) => {
        current.reading = false;
        current.issue = "mcp.import.readFailed";
      });
    }
  }

  function close(): void {
    readRun += 1;
    props.onClose();
  }

  function review(): void {
    if (busy() || selected().length === 0) return;
    props.onReview(selected().map(normalizeMcpConfig));
  }

  function nameTaken(item: McpImportItem): boolean {
    const name = item.config?.name.toLowerCase();
    return Boolean(
      name &&
        (props.servers.some((server) => server.name.toLowerCase() === name) ||
          state.items.some((other) => other.index !== item.index && other.config?.name.toLowerCase() === name)),
    );
  }

  return (
    <WizardDialog
      open
      nested
      wide
      closeLabel={t("common.close")}
      onClose={close}
      logo={<Blocks aria-hidden="true" />}
      title={t("mcp.import.title")}
      description={t("mcp.import.description")}
      onSubmit={() => {
        if (state.source) preview(state.source);
        else review();
      }}
      footer={
        <>
          <Button type="button" size="sm" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" size="sm" disabled={busy() || selected().length === 0} onClick={review}>
            {t("mcp.import.reviewSelected", { count: selected().length })}
          </Button>
        </>
      }
    >
      <Field label={t("mcp.import.pasteLabel")} description={t("mcp.import.pasteHint")}>
        <Input
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={state.source}
          disabled={props.disabled}
          onValueChange={(source) => {
            readRun += 1;
            setState((current) => {
              current.source = source;
              current.reading = false;
              current.items = [];
              current.selected = [];
              current.issue = null;
            });
          }}
        />
      </Field>
      <ItemActions>
        <Button type="submit" size="sm" variant="outline" disabled={busy() || !state.source.trim()}>
          {t("mcp.import.preview")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy()} onClick={() => fileInput?.click()}>
          <Upload aria-hidden="true" />
          {t("mcp.import.chooseFile")}
        </Button>
        <Input
          ref={(element) => {
            fileInput = element;
          }}
          hidden
          type="file"
          accept=".json,application/json"
          aria-label={t("mcp.import.chooseFile")}
          disabled={busy()}
          onChange={(event) => {
            void readFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </ItemActions>
      <Show when={state.reading}>
        <Text variant="caption" tone="muted" role="status">
          {t("mcp.import.reading")}
        </Text>
      </Show>
      <Show when={state.issue}>
        {(issue) => (
          <Text variant="caption" tone="danger" role="alert">
            {t(issue())}
          </Text>
        )}
      </Show>
      <Show when={state.items.length > 0}>
        <ItemGroup>
          <For each={state.items} keyed={(item) => item.index}>
            {(item) => (
              <Item>
                <ItemContent>
                  <ItemTitle>{item().name || t("mcp.import.unnamed", { position: item().index + 1 })}</ItemTitle>
                  <Show when={item().config}>
                    {(config) => (
                      <ItemDescription>
                        <Badge variant="outline">{config().transport === "stdio" ? "STDIO" : "HTTP"}</Badge>{" "}
                        {mcpImportDestination(config())}
                      </ItemDescription>
                    )}
                  </Show>
                  <Show when={item().issue}>{(issue) => <ItemDescription>{t(issue())}</ItemDescription>}</Show>
                  <Show when={item().needsCredentials}>
                    <ItemDescription>{t("mcp.import.credentialsMissing")}</ItemDescription>
                  </Show>
                  <Show when={nameTaken(item())}>
                    <ItemDescription>{t("mcp.import.renameNeeded")}</ItemDescription>
                  </Show>
                </ItemContent>
                <ItemActions>
                  <Checkbox
                    aria-label={t("mcp.import.select", {
                      name: item().name || t("mcp.import.unnamed", { position: item().index + 1 }),
                    })}
                    disabled={busy() || !item().config}
                    checked={state.selected.includes(item().index)}
                    onChange={(event) => {
                      const index = item().index;
                      const checked = event.currentTarget.checked;
                      setState((current) => {
                        current.selected = checked
                          ? [...current.selected, index]
                          : current.selected.filter((selectedIndex) => selectedIndex !== index);
                      });
                    }}
                  />
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </Show>
    </WizardDialog>
  );
}
