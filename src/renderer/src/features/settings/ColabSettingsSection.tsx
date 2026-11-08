import type { ColabCommandResult, ColabSnapshot } from "@openbot/contracts/ipc";
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  SettingsSection,
  Text,
  Textarea,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, For, onSettled, Show } from "solid-js";
import { colabPort } from "./colab-port";

interface State {
  snapshot: ColabSnapshot | null;
  pending: string | null;
  error: string | null;
  authorizationCode: string;
  sessionName: string;
  selected: string;
  code: string;
  result: ColabCommandResult | null;
  stopSession: string | null;
}

/** This panel uses the local CLI and never renders a Google sign-in page inside Electron. */
export function ColabSettingsSection() {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<State>({
    snapshot: null,
    pending: null,
    error: null,
    authorizationCode: "",
    sessionName: "",
    selected: "",
    code: "print('Hello from Colab')",
    result: null,
    stopSession: null,
  });
  let generation = 0;
  let actionRevision = 0;
  const busy = () => state.pending !== null;
  const installed = () => state.snapshot?.installed === true;
  const loginWaiting = () => state.snapshot?.loginPhase === "waiting-code";

  function accept(snapshot: ColabSnapshot): void {
    setState((draft) => {
      draft.snapshot = snapshot;
      if (!snapshot.sessions.some((row) => row.name === draft.selected))
        draft.selected = snapshot.sessions[0]?.name ?? "";
    });
  }

  async function action(
    name: string,
    operation: () => Promise<ColabSnapshot | void | ColabCommandResult>,
  ): Promise<void> {
    if (busy()) return;
    const current = generation;
    const revision = ++actionRevision;
    setState((draft) => {
      draft.pending = name;
      draft.error = null;
    });
    try {
      const result = await operation();
      if (current !== generation || revision !== actionRevision) return;
      if (result && "sessions" in result) accept(result);
      else if (result && "text" in result)
        setState((draft) => {
          draft.result = result;
        });
    } catch (error) {
      if (current === generation && revision === actionRevision)
        setState((draft) => {
          draft.error = errorMessage(error, t("colab.actionFailed"));
        });
    } finally {
      if (current === generation && revision === actionRevision)
        setState((draft) => {
          draft.pending = null;
        });
    }
  }

  async function load(): Promise<void> {
    const current = generation;
    try {
      const snapshot = await colabPort().getStatus();
      if (current === generation) accept(snapshot);
    } catch (error) {
      if (current === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("colab.loadFailed"));
        });
    }
  }

  onSettled(() => {
    void load();
    const timer = setInterval(() => {
      const phase = state.snapshot?.loginPhase;
      if (phase === "waiting-code" || phase === "submitting") void load();
    }, 1_000);
    return () => {
      generation += 1;
      clearInterval(timer);
    };
  });

  return (
    <>
      <SettingsSection
        title={t("colab.title")}
        description={t("colab.description")}
        actions={
          <ItemActions>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => void action("open-home", () => colabPort().openHome())}
            >
              {t("colab.openHome")}
            </Button>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => void action("refresh", () => colabPort().refresh())}
            >
              {t("colab.refresh")}
            </Button>
          </ItemActions>
        }
      >
        <ItemGroup>
          <Item>
            <ItemContent>
              <Text>
                {installed() ? t("colab.installed", { version: state.snapshot?.version ?? "" }) : t("colab.missing")}
              </Text>
              <Text variant="caption" tone="muted">
                {t("colab.proxyNote")}
              </Text>
            </ItemContent>
          </Item>
          <Item>
            <ItemContent>
              <Text>
                {state.snapshot?.connected
                  ? t("colab.connected")
                  : state.snapshot?.credentialsPresent
                    ? t("colab.credentialsSaved")
                    : t("colab.notConnected")}
              </Text>
              <Text variant="caption" tone="muted">
                {t("colab.loginHelp")}
              </Text>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={!installed() || busy()}
                loading={state.pending === "login"}
                onClick={() => void action("login", () => colabPort().startLogin())}
              >
                {t("colab.login")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
        <Show when={loginWaiting() || state.snapshot?.loginPhase === "submitting"}>
          <ItemGroup>
            <Item>
              <ItemContent>
                <Text>{t("colab.codeHelp")}</Text>
                <Field label={t("colab.authorizationCode")}>
                  <Input
                    type="password"
                    value={state.authorizationCode}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.authorizationCode = value;
                      })
                    }
                    disabled={busy() || !loginWaiting()}
                    autocomplete="off"
                  />
                </Field>
              </ItemContent>
            </Item>
            <Item>
              <ItemActions>
                <Button
                  variant="outline"
                  disabled={busy() || !state.snapshot?.canOpenAuthorization}
                  onClick={() => void action("open-login", () => colabPort().openAuthorization())}
                >
                  {t("colab.openAuthorization")}
                </Button>
                <Button
                  disabled={busy() || !loginWaiting() || state.authorizationCode.trim().length < 8}
                  loading={state.pending === "code"}
                  onClick={() => {
                    const code = state.authorizationCode;
                    setState((draft) => {
                      draft.authorizationCode = "";
                    });
                    void action("code", () => colabPort().submitLoginCode({ code }));
                  }}
                >
                  {t("colab.submitCode")}
                </Button>
                <Button
                  variant="outline"
                  disabled={state.pending === "cancel"}
                  onClick={() => {
                    setState((draft) => {
                      draft.pending = null;
                      draft.authorizationCode = "";
                    });
                    void action("cancel", () => colabPort().cancelLogin());
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </ItemActions>
            </Item>
          </ItemGroup>
        </Show>
        <Show when={state.snapshot?.message}>
          <Text variant="caption" tone="danger" role="alert">
            {errorMessage(state.snapshot?.message, t("colab.actionFailed"))}
          </Text>
        </Show>
      </SettingsSection>
      <SettingsSection title={t("colab.sessionsTitle")} description={t("colab.sessionsHelp")}>
        <ItemGroup>
          <For each={state.snapshot?.sessions ?? []}>
            {(session) => (
              <Item>
                <ItemContent>
                  <Text>{session.name}</Text>
                  <Text variant="caption" tone="muted">
                    {t("colab.sessionDetails", {
                      hardware: session.hardware,
                      shape: session.shape,
                      state:
                        session.state === "busy"
                          ? t("colab.busy")
                          : session.state === "idle"
                            ? t("colab.idle")
                            : t("colab.unknown"),
                    })}
                  </Text>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    disabled={busy()}
                    onClick={() =>
                      setState((draft) => {
                        draft.selected = session.name;
                      })
                    }
                  >
                    {t("colab.selectSession")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy()}
                    onClick={() =>
                      void action("open-session", () => colabPort().openSession({ session: session.name }))
                    }
                  >
                    {t("colab.openSession")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy()}
                    onClick={() =>
                      setState((draft) => {
                        draft.stopSession = session.name;
                      })
                    }
                  >
                    {t("colab.stop")}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
          <Show when={state.snapshot?.sessions.length === 0}>
            <Item>
              <ItemContent>
                <Text tone="muted">{t("colab.empty")}</Text>
              </ItemContent>
            </Item>
          </Show>
          <Show when={(state.snapshot?.unmanagedSessions ?? 0) > 0}>
            <Item>
              <ItemContent>
                <Text variant="caption" tone="muted">
                  {t("colab.unmanaged", { count: state.snapshot?.unmanagedSessions ?? 0 })}
                </Text>
              </ItemContent>
            </Item>
          </Show>
          <Item>
            <ItemContent>
              <Field label={t("colab.sessionName")} description={t("colab.cpuHelp")}>
                <Input
                  value={state.sessionName}
                  onValueChange={(value) =>
                    setState((draft) => {
                      draft.sessionName = value;
                    })
                  }
                  maxlength={128}
                  disabled={busy()}
                />
              </Field>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={!installed() || busy()}
                loading={state.pending === "create"}
                onClick={() =>
                  void action("create", () =>
                    colabPort().createCpu(state.sessionName.trim() ? { name: state.sessionName.trim() } : {}),
                  )
                }
              >
                {t("colab.createCpu")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("colab.executeTitle")} description={t("colab.executeHelp")}>
        <ItemGroup>
          <Item>
            <ItemContent>
              <Field label={t("colab.selectedSession")}>
                <Input
                  value={state.selected}
                  onValueChange={(value) =>
                    setState((draft) => {
                      draft.selected = value;
                    })
                  }
                  disabled={busy()}
                />
              </Field>
              <Field label={t("colab.code")}>
                <Textarea
                  value={state.code}
                  onValueChange={(value) =>
                    setState((draft) => {
                      draft.code = value;
                    })
                  }
                  rows={7}
                  disabled={busy()}
                  spellcheck={false}
                />
              </Field>
            </ItemContent>
          </Item>
          <Item>
            <ItemActions>
              <Button
                disabled={!installed() || busy() || !state.selected || !state.code.trim()}
                loading={state.pending === "execute"}
                onClick={() =>
                  void action("execute", () =>
                    colabPort().execute({ session: state.selected, code: state.code, timeoutSeconds: 60 }),
                  )
                }
              >
                {t("colab.execute")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
        <Show when={state.result}>
          <Field label={t("colab.output")}>
            <Textarea readonly value={state.result?.text ?? ""} rows={8} />
          </Field>
          <Show when={state.result?.truncated}>
            <Text variant="caption" tone="muted">
              {t("colab.truncated")}
            </Text>
          </Show>
        </Show>
      </SettingsSection>
      <ConfirmDialog
        open={state.stopSession !== null}
        title={t("colab.stopTitle")}
        description={t("colab.stopDescription")}
        confirmLabel={t("colab.stop")}
        pending={state.pending === "stop"}
        onCancel={() =>
          setState((draft) => {
            draft.stopSession = null;
          })
        }
        onConfirm={async () => {
          const session = state.stopSession;
          if (!session) return;
          await action("stop", () => colabPort().stop({ session }));
          setState((draft) => {
            draft.stopSession = null;
          });
        }}
      />
      <Show when={state.error}>
        {(message) => (
          <Text tone="danger" role="alert">
            {message()}
          </Text>
        )}
      </Show>
    </>
  );
}
