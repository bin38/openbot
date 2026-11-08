import {
  DEFAULT_GEMINI_PROXY_SETTINGS,
  type GeminiProxySettings as GeminiProxyValue,
  normalizeGeminiProxyUrl,
  type SetGeminiProxySettingsInput,
} from "@openbot/contracts/ipc";
import {
  Button,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  SettingsSection,
  SwitchField,
  Text,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, onSettled, Show } from "solid-js";
import { geminiProxyPort } from "./gemini-proxy-port";

interface GeminiProxyForm {
  saved: GeminiProxyValue | null;
  draft: SetGeminiProxySettingsInput;
  pending: "load" | "save" | null;
  error: string | null;
  savedNotice: boolean;
  password: string;
  clearPassword: boolean;
}

/** Local Gemini preferences. The provider page owns this form's lifetime. */
export function GeminiProxySettings() {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<GeminiProxyForm>({
    saved: null,
    draft: { ...DEFAULT_GEMINI_PROXY_SETTINGS },
    pending: "load",
    error: null,
    savedNotice: false,
    password: "",
    clearPassword: false,
  });
  let generation = 0;
  const dirty = () =>
    state.saved !== null &&
    (state.saved.enabled !== state.draft.enabled ||
      state.saved.proxyUrl !== state.draft.proxyUrl ||
      Boolean(state.draft.username) ||
      Boolean(state.password) ||
      state.clearPassword);
  const invalidAddress = () => normalizeGeminiProxyUrl(state.draft.proxyUrl) === null;
  const disabled = () => state.pending !== null || state.saved === null;

  async function load(): Promise<void> {
    const current = ++generation;
    setState((draft) => {
      draft.pending = "load";
      draft.error = null;
      draft.savedNotice = false;
    });
    try {
      const value = await geminiProxyPort().getSettings();
      if (current !== generation) return;
      setState((draft) => {
        draft.saved = { ...value };
        draft.draft = { ...value };
      });
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("provider.geminiProxy.loadFailed"));
        });
    } finally {
      if (current === generation)
        setState((draft) => {
          draft.pending = null;
        });
    }
  }

  onSettled(() => {
    void load();
    return () => {
      generation += 1;
    };
  });

  function edit(change: Partial<SetGeminiProxySettingsInput>): void {
    setState((draft) => {
      Object.assign(draft.draft, change);
      draft.error = null;
      draft.savedNotice = false;
    });
  }

  function reset(): void {
    const saved = state.saved;
    if (!saved || state.pending) return;
    setState((draft) => {
      draft.draft = { ...saved };
      draft.password = "";
      draft.clearPassword = false;
      draft.error = null;
      draft.savedNotice = false;
    });
  }

  async function save(): Promise<void> {
    if (disabled() || !dirty() || invalidAddress()) return;
    const current = generation;
    const next = {
      enabled: state.draft.enabled,
      proxyUrl: state.draft.proxyUrl.trim(),
      username: state.draft.username ?? "",
      password: state.password,
      clearPassword: state.clearPassword,
    };
    setState((draft) => {
      draft.pending = "save";
      draft.error = null;
      draft.savedNotice = false;
    });
    try {
      const saved = await geminiProxyPort().setSettings(next);
      if (current !== generation) return;
      setState((draft) => {
        draft.saved = { ...saved };
        draft.draft = { ...saved };
        draft.savedNotice = true;
        draft.password = "";
        draft.clearPassword = false;
      });
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("provider.geminiProxy.saveFailed"));
        });
    } finally {
      if (current === generation)
        setState((draft) => {
          draft.pending = null;
        });
    }
  }

  return (
    <SettingsSection
      title={t("provider.geminiProxy.title")}
      description={t("provider.geminiProxy.description")}
      actions={
        <ItemActions>
          <Button variant="outline" disabled={disabled() || !dirty()} onClick={reset}>
            {t("provider.geminiProxy.reset")}
          </Button>
          <Button
            disabled={disabled() || !dirty() || invalidAddress()}
            loading={state.pending === "save"}
            onClick={() => void save()}
          >
            {t("common.save")}
          </Button>
        </ItemActions>
      }
    >
      <Show when={state.pending === "load"}>
        <Text variant="caption" tone="muted" role="status">
          {t("common.loading")}
        </Text>
      </Show>
      <ItemGroup>
        <SwitchField
          label={t("provider.geminiProxy.enabled")}
          description={t("provider.geminiProxy.enabledDescription")}
          checked={state.draft.enabled}
          disabled={disabled()}
          onChange={(enabled) => edit({ enabled })}
        />
        <Item>
          <ItemContent>
            <Field
              label={t("provider.geminiProxy.address")}
              description={t("provider.geminiProxy.addressHelp")}
              error={state.saved !== null && invalidAddress() ? t("provider.geminiProxy.addressInvalid") : undefined}
            >
              <Input
                value={state.draft.proxyUrl}
                onValueChange={(proxyUrl) => edit({ proxyUrl })}
                placeholder={DEFAULT_GEMINI_PROXY_SETTINGS.proxyUrl}
                disabled={disabled()}
                maxlength={2048}
                inputmode="url"
                autocomplete="off"
                spellcheck={false}
              />
            </Field>
          </ItemContent>
        </Item>
        <Item>
          <ItemContent>
            <Field
              label={t("provider.geminiProxy.username")}
              description={
                state.saved?.hasUsername ? t("provider.geminiProxy.usernameSaved") : t("provider.geminiProxy.authHelp")
              }
            >
              <Input
                type="password"
                value={state.draft.username ?? ""}
                onValueChange={(username) => edit({ username })}
                disabled={disabled()}
                maxlength={255}
                autocomplete="off"
                spellcheck={false}
              />
            </Field>
          </ItemContent>
        </Item>
        <Item>
          <ItemContent>
            <Field
              label={t("provider.geminiProxy.password")}
              description={
                state.saved?.hasPassword
                  ? t("provider.geminiProxy.passwordSaved")
                  : t("provider.geminiProxy.passwordHelp")
              }
            >
              <Input
                type="password"
                value={state.password}
                onValueChange={(password) =>
                  setState((draft) => {
                    draft.password = password;
                    draft.error = null;
                    draft.savedNotice = false;
                  })
                }
                disabled={disabled() || state.clearPassword}
                maxlength={255}
                autocomplete="new-password"
              />
            </Field>
          </ItemContent>
        </Item>
        <Show when={state.saved?.hasUsername || state.saved?.hasPassword}>
          <SwitchField
            label={t("provider.geminiProxy.clearPassword")}
            checked={state.clearPassword}
            disabled={disabled()}
            onChange={(clearPassword) =>
              setState((draft) => {
                draft.clearPassword = clearPassword;
                if (clearPassword) {
                  draft.draft.username = "";
                  draft.password = "";
                }
                draft.error = null;
                draft.savedNotice = false;
              })
            }
          />
        </Show>
      </ItemGroup>
      <Text variant="caption" tone="muted">
        {t("provider.geminiProxy.scopeNote")}
      </Text>
      <Show when={state.savedNotice}>
        <Text variant="caption" role="status">
          {t("provider.geminiProxy.saved")}
        </Text>
      </Show>
      <Show when={state.error}>
        {(message) => (
          <Text variant="caption" tone="danger" role="alert">
            {message()}
          </Text>
        )}
      </Show>
      <Show when={state.saved === null && state.error}>
        <Button variant="outline" disabled={state.pending !== null} onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </Show>
    </SettingsSection>
  );
}
