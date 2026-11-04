import type { AppVariant, CentralAuthState, MobileConnectAvailability } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Button,
  ConfirmDialog,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Text,
} from "@openbot/ui";
import { AccountLogin } from "@openbot/ui/features/account/AccountLogin";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, Show } from "solid-js";

/** Real account state and actions. Local workspace identity is not an account session. */
export interface SelfHostedAccountAccess {
  state: CentralAuthState;
  onRetry: () => Promise<void>;
  onRequestEmailCode: (email: string) => Promise<void>;
  onVerifyEmailCode: (challengeId: string, code: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

const STATUS_TEXT = {
  unconfigured: "settings.mobileConnect.selfHosted.unconfigured",
  "local-only": "settings.mobileConnect.selfHosted.localOnly",
  "signed-out": "settings.mobileConnect.selfHosted.signedOut",
  unpublished: "settings.mobileConnect.selfHosted.unpublished",
  ready: "settings.mobileConnect.selfHosted.ready",
} as const satisfies Record<MobileConnectAvailability["state"], AppTextKey>;

/** Reading setup never publishes a host. Sign-in and phone pairing each need an explicit action. */
export function SettingsMobileConnectSetup(props: {
  variant: AppVariant;
  account: SelfHostedAccountAccess | undefined;
  availability: MobileConnectAvailability | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenAccount: (origin: string) => void;
}) {
  const { t } = useText();
  const [guideOpen, setGuideOpen] = createSignal(false);
  const [signOut, setSignOut] = createStore<{ confirm: boolean; busy: boolean; error: string | null }>({
    confirm: false,
    busy: false,
    error: null,
  });
  const signedIn = () => {
    const state = props.account?.state;
    return state?.status === "signed_in" ? state.user : null;
  };
  async function disconnectAccount(): Promise<void> {
    if (signOut.busy || !props.account) return;
    setSignOut((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await props.account.onSignOut();
      setSignOut((draft) => {
        draft.confirm = false;
      });
      props.onRefresh();
    } catch {
      setSignOut((draft) => {
        draft.error = t("account.menu.signOutFailed");
      });
    } finally {
      setSignOut((draft) => {
        draft.busy = false;
      });
    }
  }
  return (
    <SettingsSection
      title={t("settings.mobileConnect.selfHosted.title")}
      description={t("settings.mobileConnect.selfHosted.description")}
    >
      <ItemGroup>
        <Item>
          <ItemContent>
            <ItemTitle>
              {props.availability
                ? t(STATUS_TEXT[props.availability.state])
                : t("settings.mobileConnect.selfHosted.checking")}
            </ItemTitle>
            <ItemDescription>{t("settings.mobileConnect.selfHosted.requirements")}</ItemDescription>
            <Show when={props.availability?.accountOrigin}>
              {(origin) => (
                <Text variant="caption" tone="muted">
                  {t("settings.mobileConnect.selfHosted.origin", { origin: origin() })}
                </Text>
              )}
            </Show>
            <Show when={props.error}>
              {(error) => (
                <Text tone="danger" role="alert">
                  {error()}
                </Text>
              )}
            </Show>
          </ItemContent>
          <ItemActions>
            <Button variant="outline" loading={props.loading} onClick={() => props.onRefresh()}>
              {t("settings.mobileConnect.selfHosted.refresh")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setGuideOpen((open) => !open)}
              aria-expanded={guideOpen() ? "true" : "false"}
            >
              {t("settings.mobileConnect.selfHosted.guide")}
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>
      <Show when={props.availability?.accountOrigin ? props.account : undefined}>
        {(account) => (
          <Show
            when={signedIn()}
            fallback={
              <AccountLogin
                layout="embedded"
                variant={props.variant}
                state={account().state}
                onRetry={() => account().onRetry()}
                onRequestEmailCode={(email) => account().onRequestEmailCode(email)}
                onVerifyEmailCode={(challengeId, code) => account().onVerifyEmailCode(challengeId, code)}
                onReset={() => account().onSignOut()}
              />
            }
          >
            {(user) => (
              <ItemGroup>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t("settings.mobileConnect.selfHosted.signedInAs", { email: user().email })}</ItemTitle>
                    <ItemDescription>{t("settings.mobileConnect.selfHosted.publishHelp")}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant="outline"
                      loading={signOut.busy}
                      onClick={() =>
                        setSignOut((draft) => {
                          draft.confirm = true;
                          draft.error = null;
                        })
                      }
                    >
                      {t("account.menu.signOut")}
                    </Button>
                  </ItemActions>
                </Item>
              </ItemGroup>
            )}
          </Show>
        )}
      </Show>
      <ConfirmDialog
        open={signOut.confirm}
        pending={signOut.busy}
        error={signOut.error}
        tone="default"
        title={t("settings.mobileConnect.selfHosted.signOutTitle")}
        description={t("settings.mobileConnect.selfHosted.signOutDescription")}
        confirmLabel={t("account.menu.signOut")}
        onCancel={() =>
          setSignOut((draft) => {
            draft.confirm = false;
          })
        }
        onConfirm={disconnectAccount}
      />
      <Show when={guideOpen()}>
        <SettingsSection title={t("settings.mobileConnect.selfHosted.guide")}>
          <Text>{t("settings.mobileConnect.selfHosted.stepServices")}</Text>
          <Text>{t("settings.mobileConnect.selfHosted.stepHost")}</Text>
          <Text>{t("settings.mobileConnect.selfHosted.stepPhone")}</Text>
          <Text>{t("settings.mobileConnect.selfHosted.localIdentity")}</Text>
          <Show when={props.availability?.accountOrigin}>
            {(origin) => (
              <Button variant="outline" onClick={() => props.onOpenAccount(origin())}>
                {t("settings.mobileConnect.selfHosted.openAccount")}
              </Button>
            )}
          </Show>
        </SettingsSection>
      </Show>
    </SettingsSection>
  );
}
