import type {
  ApiChannelDefinition,
  ApiChannelOperation,
  ApiChannelSummary,
  SaveApiChannelInput,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  Button,
  Field,
  Globe2,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SwitchField,
  Text,
  Textarea,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, For, onSettled, Show, untrack } from "solid-js";
import { WizardDialog } from "./IntegrationLayout";

const AUTH_TYPES = ["none", "bearer", "header", "query"] as const;
const AUTH_LABEL = {
  none: "apiChannels.editor.auth.none",
  bearer: "apiChannels.editor.auth.bearer",
  header: "apiChannels.editor.auth.header",
  query: "apiChannels.editor.auth.query",
} as const satisfies Record<ApiChannelDefinition["auth"]["type"], AppTextKey>;

export interface ApiChannelEditorProps {
  definition: ApiChannelDefinition;
  existing: ApiChannelSummary | null;
  onValidate: (definitionJson: string) => Promise<ApiChannelDefinition>;
  onSave: (input: SaveApiChannelInput) => Promise<void>;
  onClose: () => void;
}

/** Keeps the credential separate from declarative request JSON and discards it after a save. */
export function ApiChannelEditor(props: ApiChannelEditorProps) {
  const { t, errorMessage } = useText();
  const [popupMount, setPopupMount] = createSignal<HTMLElement | undefined>(undefined);
  const initial = untrack(() => props.definition);
  const existing = untrack(() => props.existing);
  const [state, setState] = createStore<{
    name: string;
    description: string;
    baseUrl: string;
    authType: ApiChannelDefinition["auth"]["type"];
    authName: string;
    authPrefix: string;
    apiKey: string;
    clearApiKey: boolean;
    enabled: boolean;
    headersJson: string;
    artifactHosts: string;
    operationsJson: string;
    operations: ApiChannelOperation[];
    advanced: boolean;
    importing: boolean;
    importJson: string;
    validated: boolean;
    busy: "validate" | "import" | "save" | null;
    error: string | null;
  }>({
    name: initial.name,
    description: initial.description,
    baseUrl: initial.baseUrl,
    authType: initial.auth.type,
    authName: initial.auth.name,
    authPrefix: initial.auth.prefix,
    apiKey: "",
    clearApiKey: false,
    enabled: existing?.enabled ?? false,
    headersJson: JSON.stringify(initial.headers, null, 2),
    artifactHosts: initial.artifactHosts.join("\n"),
    operationsJson: JSON.stringify(initial.operations, null, 2),
    operations: initial.operations,
    advanced: initial.operations.length === 0,
    importing: false,
    importJson: "",
    validated: false,
    busy: null,
    error: null,
  });
  const busy = () => state.busy !== null;
  let alive = true;
  onSettled(() => () => {
    alive = false;
  });

  function definitionJson(): string {
    try {
      const headers = JSON.parse(state.headersJson);
      const operations = JSON.parse(state.operationsJson);
      return JSON.stringify({
        name: state.name.trim(),
        description: state.description.trim(),
        baseUrl: state.baseUrl.trim(),
        auth: { type: state.authType, name: state.authName, prefix: state.authPrefix },
        headers,
        artifactHosts: state.artifactHosts
          .split("\n")
          .map((host) => host.trim())
          .filter(Boolean),
        operations,
      });
    } catch {
      throw new Error(t("apiChannels.editor.invalidJson"));
    }
  }

  function applyDefinition(definition: ApiChannelDefinition): void {
    setState((draft) => {
      draft.name = definition.name;
      draft.description = definition.description;
      draft.baseUrl = definition.baseUrl;
      draft.authType = definition.auth.type;
      draft.authName = definition.auth.name;
      draft.authPrefix = definition.auth.prefix;
      draft.headersJson = JSON.stringify(definition.headers, null, 2);
      draft.artifactHosts = definition.artifactHosts.join("\n");
      draft.operationsJson = JSON.stringify(definition.operations, null, 2);
      draft.operations = definition.operations;
      // A pasted definition may name another origin. Never carry a newly entered key to it.
      draft.apiKey = "";
      draft.clearApiKey = false;
      draft.importing = false;
      draft.importJson = "";
      draft.validated = true;
    });
  }

  async function act(kind: "validate" | "import" | "save"): Promise<void> {
    if (busy()) return;
    setState((draft) => {
      draft.busy = kind;
      draft.error = null;
      draft.validated = false;
    });
    try {
      const definition = await props.onValidate(kind === "import" ? state.importJson : definitionJson());
      if (!alive) return;
      if (kind === "import") applyDefinition(definition);
      else {
        setState((draft) => {
          draft.operations = definition.operations;
          draft.validated = true;
        });
        if (kind === "save") {
          await props.onSave({
            ...(existing ? { id: existing.id } : {}),
            definitionJson: JSON.stringify(definition),
            enabled: state.enabled,
            ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
            ...(state.clearApiKey ? { clearApiKey: true } : {}),
          });
          if (alive)
            setState((draft) => {
              draft.apiKey = "";
            });
        }
      }
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(
            error,
            t(kind === "save" ? "apiChannels.saveFailed" : "apiChannels.editor.validationFailed"),
          );
        });
    } finally {
      if (alive)
        setState((draft) => {
          draft.busy = null;
        });
    }
  }

  function close(): void {
    if (!busy()) props.onClose();
  }

  return (
    <WizardDialog
      open
      nested
      wide
      contentRef={setPopupMount}
      closeLabel={t("common.close")}
      closeDisabled={busy()}
      onClose={close}
      logo={<Globe2 aria-hidden="true" />}
      title={t(existing ? "apiChannels.editor.editTitle" : "apiChannels.editor.addTitle")}
      description={t("apiChannels.editor.description")}
      onSubmit={() => void act("save")}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={busy()} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy()}
            loading={state.busy === "validate"}
            onClick={() => void act("validate")}
          >
            {t("apiChannels.editor.validate")}
          </Button>
          <Button type="submit" disabled={busy()} loading={state.busy === "save"}>
            {t("apiChannels.editor.save")}
          </Button>
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
      <Show when={state.validated}>
        <Text tone="muted" role="status">
          {t("apiChannels.editor.validated")}
        </Text>
      </Show>
      <Field label={t("apiChannels.editor.name")} required>
        <Input
          value={state.name}
          disabled={busy()}
          onValueChange={(name) =>
            setState((draft) => {
              draft.name = name;
              draft.validated = false;
            })
          }
        />
      </Field>
      <Field label={t("apiChannels.editor.descriptionField")}>
        <Input
          value={state.description}
          disabled={busy()}
          onValueChange={(description) =>
            setState((draft) => {
              draft.description = description;
              draft.validated = false;
            })
          }
        />
      </Field>
      <Field label={t("apiChannels.editor.baseUrl")} required>
        <Input
          type="url"
          value={state.baseUrl}
          disabled={busy()}
          onValueChange={(baseUrl) =>
            setState((draft) => {
              draft.baseUrl = baseUrl;
              draft.validated = false;
            })
          }
        />
      </Field>
      <Field label={t("apiChannels.editor.auth")}>
        <Select
          options={[...AUTH_TYPES]}
          value={state.authType}
          onChange={(authType) => {
            if (authType)
              setState((draft) => {
                draft.authType = authType;
                draft.validated = false;
              });
          }}
          disabled={busy()}
          itemComponent={(item) => <SelectItem item={item.item}>{t(AUTH_LABEL[item.item.rawValue])}</SelectItem>}
        >
          <SelectTrigger aria-label={t("apiChannels.editor.auth")}>
            <SelectValue<string>>{() => t(AUTH_LABEL[state.authType])}</SelectValue>
          </SelectTrigger>
          <SelectContent mount={popupMount()} />
        </Select>
      </Field>
      <Show when={state.authType === "header" || state.authType === "query"}>
        <Field label={t("apiChannels.editor.authName")} required>
          <Input
            value={state.authName}
            disabled={busy()}
            onValueChange={(authName) =>
              setState((draft) => {
                draft.authName = authName;
                draft.validated = false;
              })
            }
          />
        </Field>
      </Show>
      <Show when={state.authType !== "none"}>
        <Field label={t("apiChannels.editor.authPrefix")}>
          <Input
            value={state.authPrefix}
            disabled={busy()}
            onValueChange={(authPrefix) =>
              setState((draft) => {
                draft.authPrefix = authPrefix;
                draft.validated = false;
              })
            }
          />
        </Field>
        <Field label={t("apiChannels.editor.key")} description={t("apiChannels.editor.keyHint")}>
          <Input
            type="password"
            autocomplete="off"
            spellcheck={false}
            value={state.apiKey}
            disabled={busy() || state.clearApiKey}
            onValueChange={(apiKey) =>
              setState((draft) => {
                draft.apiKey = apiKey;
              })
            }
          />
        </Field>
        <Show when={existing?.credentialStatus === "saved" || existing?.credentialStatus === "unreadable"}>
          <SwitchField
            label={t("apiChannels.editor.clearKey")}
            checked={state.clearApiKey}
            disabled={busy()}
            onChange={(clearApiKey) =>
              setState((draft) => {
                draft.clearApiKey = clearApiKey;
                if (clearApiKey) draft.apiKey = "";
              })
            }
          />
        </Show>
      </Show>
      <SwitchField
        label={t("apiChannels.editor.enable")}
        description={t("apiChannels.editor.enableHint")}
        checked={state.enabled}
        disabled={busy()}
        onChange={(enabled) =>
          setState((draft) => {
            draft.enabled = enabled;
          })
        }
      />
      <SettingsSection title={t("apiChannels.operations", { count: state.operations.length })}>
        <Text variant="caption" tone="muted">
          {t("apiChannels.editor.operationHint")}
        </Text>
        <Show
          when={state.operations.length > 0}
          fallback={<Text tone="muted">{t("apiChannels.editor.emptyOperations")}</Text>}
        >
          <ItemGroup>
            <For each={state.operations} keyed={(operation) => operation.id}>
              {(operation) => (
                <Item>
                  <ItemContent>
                    <ItemTitle>{operation().name}</ItemTitle>
                    <ItemDescription>
                      {operation().method} {operation().path}
                    </ItemDescription>
                    <ItemDescription>{operation().description}</ItemDescription>
                    <ItemDescription>
                      <Badge variant="outline">
                        {t(operation().readOnly ? "apiChannels.editor.readOnly" : "apiChannels.editor.write")}
                      </Badge>
                      <Show when={operation().job}>
                        {" "}
                        <Badge variant="outline">{t("apiChannels.editor.job")}</Badge>
                      </Show>
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>
      </SettingsSection>
      <Button
        type="button"
        variant="outline"
        disabled={busy()}
        onClick={() =>
          setState((draft) => {
            draft.advanced = !draft.advanced;
          })
        }
      >
        {t(state.advanced ? "apiChannels.editor.hideAdvanced" : "apiChannels.editor.advanced")}
      </Button>
      <Show when={state.advanced}>
        <Field label={t("apiChannels.editor.headers")} description={t("apiChannels.editor.headersHint")}>
          <Textarea
            rows={4}
            spellcheck={false}
            value={state.headersJson}
            disabled={busy()}
            onValueChange={(headersJson) =>
              setState((draft) => {
                draft.headersJson = headersJson;
                draft.validated = false;
              })
            }
          />
        </Field>
        <Field label={t("apiChannels.editor.artifactHosts")} description={t("apiChannels.editor.artifactHostsHint")}>
          <Textarea
            rows={3}
            spellcheck={false}
            value={state.artifactHosts}
            disabled={busy()}
            onValueChange={(artifactHosts) =>
              setState((draft) => {
                draft.artifactHosts = artifactHosts;
                draft.validated = false;
              })
            }
          />
        </Field>
        <Field
          label={t("apiChannels.editor.operations")}
          description={t("apiChannels.editor.operationsHint", { example: "{{input}}" })}
        >
          <Textarea
            rows={14}
            spellcheck={false}
            value={state.operationsJson}
            disabled={busy()}
            onValueChange={(operationsJson) =>
              setState((draft) => {
                draft.operationsJson = operationsJson;
                draft.operations = [];
                draft.validated = false;
              })
            }
          />
        </Field>
      </Show>
      <Button
        type="button"
        variant="outline"
        disabled={busy()}
        onClick={() =>
          setState((draft) => {
            draft.importing = !draft.importing;
          })
        }
      >
        {t(state.importing ? "apiChannels.editor.hideImport" : "apiChannels.editor.import")}
      </Button>
      <Show when={state.importing}>
        <Field label={t("apiChannels.editor.importJson")} description={t("apiChannels.editor.importHint")}>
          <Textarea
            rows={10}
            spellcheck={false}
            value={state.importJson}
            disabled={busy()}
            onValueChange={(importJson) =>
              setState((draft) => {
                draft.importJson = importJson;
              })
            }
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={busy() || !state.importJson.trim()}
          loading={state.busy === "import"}
          onClick={() => void act("import")}
        >
          {t("apiChannels.editor.applyImport")}
        </Button>
      </Show>
    </WizardDialog>
  );
}
