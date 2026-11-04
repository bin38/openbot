import type {
  AccountSession,
  AppInfo,
  AvatarImageInput,
  BillingDesktopApi,
  CentralAuthUser,
  DynamicIslandGeometry,
  HostedServersDesktopApi,
  LicenseDesktopApi,
  MobileConnectAvailability,
  MobileConnectedDevice,
  MobileConnectLink,
  MobileConnectTicket,
  RemoteNetworkRoute,
  RemoteNetworkRouteState,
  ServerNotificationLevel,
  ServerSummary,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Button,
  ChevronRight,
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
  SettingsSection,
  Tabs,
  TriangleAlert,
} from "@openbot/ui";
import { BillingPanel } from "@openbot/ui/features/billing/BillingPanel";
import { createBillingStore } from "@openbot/ui/features/billing/billing-store";
import { LicenseSection } from "@openbot/ui/features/billing/LicenseSection";
import { createLicenseStore } from "@openbot/ui/features/billing/license-store";
import type { GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import { SettingsDialogShell, type SettingsPagePlacement } from "@openbot/ui/features/settings/SettingsDialogShell";
import { SettingsMobileConnectTab } from "@openbot/ui/features/settings/SettingsMobileConnectTab";
import { SettingsProfileTab } from "@openbot/ui/features/settings/SettingsProfileTab";
import { SettingsUpdatesTab } from "@openbot/ui/features/settings/SettingsUpdatesTab";
import { createSettingsHostedServersStore } from "@openbot/ui/features/settings/stores/hosted-servers-store";
import { createSettingsMobileConnectStore } from "@openbot/ui/features/settings/stores/mobile-connect-store";
import { createSettingsProfileStore } from "@openbot/ui/features/settings/stores/profile-store";
import { createSettingsUpdatesStore } from "@openbot/ui/features/settings/stores/updates-store";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, onCleanup, onSettled, Show, untrack } from "solid-js";
import { appPort } from "../../app-port";
import { useI18n } from "../../i18n-context";
import { accountPort } from "../account/account-port";
import { ComputerUseSetup } from "../computer-use/ComputerUseSetup";
import { serversPort } from "../servers/servers-port";
import { licenseContactUs, trackLicenseEvent } from "./license-analytics";
import { createNotificationLevelsStore } from "./notification-levels-store";
import { createProfileActivityStore } from "./profile-activity-store";
import { renderProfileShareImage } from "./profile-share-image";
import { createSettingsAgentsSection } from "./SettingsAgentsSection";
import { SettingsDynamicIslandTab } from "./SettingsDynamicIslandTab";
import { SettingsGeneralTab } from "./SettingsGeneralTab";
import { type SelfHostedAccountAccess, SettingsMobileConnectSetup } from "./SettingsMobileConnectSetup";
import { SettingsNotificationsTab } from "./SettingsNotificationsTab";
import { SettingsVoiceTab } from "./SettingsVoiceTab";
import {
  dynamicIslandSettingsShown,
  navItem,
  navItems,
  type SettingsTab,
  settingsTabForEdition,
  settingsTabShown,
} from "./settings-tabs";
import { createSettingsVoiceStore } from "./settings-voice-store";

export interface SettingsModalProps {
  open: boolean;
  value: GeneralSettingsValue;
  onValueChange: (value: GeneralSettingsValue) => void;
  /** True when the saved preferences could not be read, so the rows show default values. */
  preferencesLoadFailed?: boolean;
  /** Reads the saved preferences again. */
  onRetryPreferencesLoad?: () => void;
  appInfo: AppInfo | null;
  /** True in a window that shows one chat (#2964). It has no Dynamic Island tab: the main window owns the island. */
  chatWindow?: boolean;
  /** The built-in display's notch, null when it has none, or undefined before main answers. */
  builtInDisplayGeometry?: DynamicIslandGeometry | undefined;
  /** The servers that the Notifications and Dynamic Island tabs list. */
  servers?: readonly ServerSummary[];
  /** Writes the notification level of a server. Resolves after `servers` shows it. */
  onSetServerNotificationLevel?: ((serverId: string, level: ServerNotificationLevel) => Promise<void>) | undefined;
  /** Mutes a server on this computer. No duration mutes until the user unmutes. */
  onSetServerMuted?: ((serverId: string, muted: boolean, durationMs?: number) => Promise<void>) | undefined;
  /** The server that the Notifications tab moves to. Each nonce moves once. */
  notificationFocusRequest?: { serverId: string; nonce: number } | null | undefined;
  updateStatus: UpdateStatus;
  onUpdateAction: () => Promise<void>;
  onOpenWhatsNew?: (() => void) | undefined;
  onCancelScheduledRestart?: () => Promise<void>;
  onRestartWhenIdle?: () => Promise<void>;
  onCancelIdleRestart?: () => Promise<void>;
  account: CentralAuthUser;
  /** Separate from the local owner shown in the workspace. Never grants remote access by itself. */
  selfHostedAccount?: SelfHostedAccountAccess;
  onUpdateAccountName: (name: string) => Promise<void>;
  onUpdateAccountAvatar: (image: AvatarImageInput | null) => Promise<void>;
  onCreateMobileConnect?: () => Promise<MobileConnectTicket>;
  onCancelMobileConnect?: () => Promise<void>;
  onGetMobileConnectLink?: () => Promise<MobileConnectLink | null>;
  onCreateMobileConnectLink?: () => Promise<MobileConnectLink>;
  onRevokeMobileConnectLink?: () => Promise<void>;
  onListMobileConnectedDevices?: () => Promise<MobileConnectedDevice[]>;
  onRevokeMobileConnectedDevice?: (sessionId: string) => Promise<void>;
  onGetRemoteNetworkRoute?: () => Promise<RemoteNetworkRouteState>;
  onSetRemoteNetworkRoute?: (route: RemoteNetworkRoute) => Promise<RemoteNetworkRouteState>;
  onListAccountSessions?: () => Promise<AccountSession[]>;
  onRevokeAccountSession?: (sessionId: string) => Promise<void>;
  onSignOut?: (() => Promise<void>) | undefined;
  processAvatarFile?: (file: File) => Promise<AvatarImageInput>;
  billingApi?: BillingDesktopApi | undefined;
  /** The commercial license of the account. It shows only when the account server sells licenses. */
  licenseApi?: LicenseDesktopApi | undefined;
  /** Opens the sales contact, for a license with more users than the app sells. */
  onContactUs?: (() => void) | undefined;
  /** The account's hosted servers. The tab is shown only when the account server offers them. */
  hostedServersApi?: HostedServersDesktopApi | undefined;
  /** Opens the add server dialog from the Hosted servers tab. */
  onAddHostedServer?: (() => void) | undefined;
  /** A hosted server that the server menu asked to delete. Each nonce opens its confirmation once. */
  hostedServerDeleteRequest?: { serverId: string; nonce: number } | null;
  onTestNotification?: () => void | Promise<void>;
  /** Opens the operating system notification settings. Shown only on macOS and Windows. */
  onOpenNotificationSettings?: () => void | Promise<void>;
  restoreFocusTarget?: HTMLElement | null;
  /** The tab shown when the modal is created. Read once; the user moves between tabs after that. */
  initialTab?: SettingsTab | undefined;
  /** The tab shown each time the modal opens. Without it, the modal shows the tab that was open last. */
  openTab?: SettingsTab | undefined;
  /** Where the settings page shows, or nothing while the page is not on screen. */
  page: SettingsPagePlacement | undefined;
}

/**
 * The dialog shell: the tab list, the header, and one delegation per panel.
 *
 * Every panel's state is a store created here rather than inside its tab, because Kobalte unmounts
 * an unselected `Tabs.Content` when the dialog closes. A list owned by the tab would lose the rows
 * it is showing while it refetches on reopen.
 */
export function SettingsModal(props: SettingsModalProps) {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = createSignal<SettingsTab>(untrack(() => settingsTabForEdition(props.initialTab)));
  let modalElement: HTMLElement | undefined;
  const mobileVisible = createMemo(() => props.open && activeTab() === "mobile-connect");
  const [mobileAccess, setMobileAccess] = createStore<{
    availability: MobileConnectAvailability | null;
    loading: boolean;
    error: string | null;
  }>({ availability: untrack(() => props.appInfo?.mobileConnectAvailability ?? null), loading: false, error: null });
  let mobileAccessRequest = 0;
  onCleanup(() => {
    mobileAccessRequest += 1;
  });
  async function refreshMobileAccess(): Promise<void> {
    if (!INDEPENDENT_EDITION) return;
    const request = ++mobileAccessRequest;
    setMobileAccess((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    try {
      const info = await appPort().getAppInfo();
      if (request === mobileAccessRequest)
        setMobileAccess((draft) => {
          draft.availability = info.mobileConnectAvailability ?? null;
        });
    } catch (error) {
      if (request === mobileAccessRequest)
        setMobileAccess((draft) => {
          draft.availability = null;
          const text = currentText();
          draft.error = text.errorMessage(error, text.t("settings.mobileConnect.selfHosted.checkFailed"));
        });
    } finally {
      if (request === mobileAccessRequest)
        setMobileAccess((draft) => {
          draft.loading = false;
        });
    }
  }
  createEffect(mobileVisible, (active) => {
    if (active) void refreshMobileAccess();
  });
  onSettled(() => {
    if (!INDEPENDENT_EDITION) return;
    const changed = () => {
      if (untrack(mobileVisible)) void refreshMobileAccess();
    };
    const unsubscribeAccount = accountPort().auth.onEvent(changed);
    const unsubscribeHost = serversPort().host.onEvent(changed);
    return () => {
      unsubscribeAccount();
      unsubscribeHost();
    };
  });
  const mobileAccountKey = createMemo(() => {
    if (!INDEPENDENT_EDITION) return props.account.id;
    const account = props.selfHostedAccount?.state;
    const availability = mobileAccess.availability;
    if (
      account?.status !== "signed_in" ||
      !availability?.accountOrigin ||
      (availability.state !== "unpublished" && availability.state !== "ready")
    )
      return null;
    return `${availability.accountOrigin}\n${account.user.id}`;
  });
  const profile = createSettingsProfileStore(props, () => !INDEPENDENT_EDITION && activeTab() === "profile");
  const profileActivity = createProfileActivityStore(
    () => !INDEPENDENT_EDITION && props.open && activeTab() === "profile",
    (stats) => renderProfileShareImage(props.account, stats),
  );
  const updates = createSettingsUpdatesStore(props);
  const billing = createBillingStore(
    () => (INDEPENDENT_EDITION ? undefined : props.billingApi),
    () => !INDEPENDENT_EDITION && props.open && activeTab() === "billing",
  );
  const license = createLicenseStore(
    () => (INDEPENDENT_EDITION ? undefined : props.licenseApi),
    () => !INDEPENDENT_EDITION && props.open && activeTab() === "billing",
    trackLicenseEvent,
  );
  const hostedServers = createSettingsHostedServersStore(
    INDEPENDENT_EDITION ? { open: false } : props,
    () => !INDEPENDENT_EDITION && activeTab() === "billing",
  );
  const voice = createSettingsVoiceStore(() => props.open && activeTab() === "voice");
  const notificationLevels = createNotificationLevelsStore({
    visible: () => props.open && activeTab() === "notifications",
    servers: () => props.servers ?? [],
  });
  const agents = createSettingsAgentsSection({
    visible: () => props.open && activeTab() === "agents",
    value: () => props.value,
    onValueChange: (value) => props.onValueChange(value),
  });
  let handledHostedServerDeleteNonce = 0;
  createEffect(
    () => (!INDEPENDENT_EDITION && props.open ? props.hostedServerDeleteRequest : null),
    (request) => {
      if (!request || request.nonce === handledHostedServerDeleteNonce) return;
      handledHostedServerDeleteNonce = request.nonce;
      hostedServers.requestDeleteById(request.serverId);
    },
  );

  const dynamicIslandShown = () => dynamicIslandSettingsShown(props.appInfo?.platform, props.chatWindow === true);
  createEffect(
    () => {
      const tab = props.open ? props.openTab : undefined;
      return tab === undefined ? undefined : settingsTabForEdition(tab);
    },
    (tab) => {
      if (!tab) return;
      setActiveTab(tab);
      agents.showList();
    },
  );
  const visibleNavItems = () => navItems.filter((item) => settingsTabShown(item.value, dynamicIslandShown()));

  const title = () => i18n.t(navItem(activeTab()).titleKey);
  const description = () => i18n.t(navItem(activeTab()).descriptionKey);

  const tabsProps = {
    get value() {
      return activeTab();
    },
    onChange(value: string) {
      if (
        value === "general" ||
        value === "agents" ||
        value === "notifications" ||
        value === "voice" ||
        (value === "dynamic-island" && dynamicIslandShown()) ||
        value === "computer-use" ||
        (!INDEPENDENT_EDITION && value === "profile") ||
        (!INDEPENDENT_EDITION && value === "billing") ||
        value === "mobile-connect" ||
        (!INDEPENDENT_EDITION && value === "updates")
      ) {
        setActiveTab(value);
      }
    },
    orientation: "vertical" as const,
    activationMode: "automatic" as const,
  };

  /** Shown above the rows that the preference read fills, while those rows show default values. */
  const preferencesLoadError = () => (
    <Show when={props.preferencesLoadFailed}>
      <Alert tone="danger" role="alert" report={{ operation: "settings", source: "system", cause_code: "unknown" }}>
        <AlertIcon>
          <TriangleAlert aria-hidden="true" />
        </AlertIcon>
        <AlertContent>
          <AlertDescription>{i18n.t("settings.preferences.loadFailed")}</AlertDescription>
        </AlertContent>
        <Show when={props.onRetryPreferencesLoad}>
          {(retry) => (
            <AlertActions>
              <Button type="button" variant="outline" size="sm" onClick={() => retry()()}>
                {i18n.t("common.retry")}
              </Button>
            </AlertActions>
          )}
        </Show>
      </Alert>
    </Show>
  );

  function updateSetting<Key extends keyof GeneralSettingsValue>(key: Key, value: GeneralSettingsValue[Key]): void {
    props.onValueChange({ ...props.value, [key]: value });
  }

  function updateSettings(patch: Partial<GeneralSettingsValue>): void {
    props.onValueChange({ ...props.value, ...patch });
  }

  return (
    <Tabs.Root {...tabsProps} class="settings-modal-tabs-root">
      <SettingsDialogShell
        class="app-settings-modal-shell"
        page={props.page}
        open={props.open}
        title={
          <Show when={activeTab() === "agents" && agents.crumb()} fallback={title()}>
            {(detail) => (
              <span class="settings-modal-crumbs">
                <Button type="button" variant="ghost" class="settings-modal-crumb-parent" onClick={detail().back}>
                  {title()}
                </Button>
                <ChevronRight class="settings-modal-crumb-separator" aria-hidden="true" />
                <span class="settings-modal-crumb-current">{detail().title}</span>
              </span>
            )}
          </Show>
        }
        description={description()}
        contentKey={`${activeTab()}:${agents.crumb()?.title ?? ""}`}
        restoreFocusTarget={props.restoreFocusTarget}
        onContentElement={(element) => (modalElement = element)}
        sidebar={
          <Tabs.List class="settings-modal-nav" aria-label={i18n.t("settings.sections.label")}>
            {visibleNavItems().map((item) => {
              const NavIcon = item.icon;
              return (
                <Tabs.Trigger
                  class="settings-modal-nav-item"
                  value={item.value}
                  aria-current={activeTab() === item.value ? "page" : undefined}
                >
                  <NavIcon aria-hidden="true" />
                  <span>{i18n.t(item.titleKey)}</span>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        }
      >
        <Tabs.Content value="general" class="settings-modal-tab-panel" data-tab="general">
          {preferencesLoadError()}
          <Show when={props.appInfo?.localWorkspace}>
            {(workspace) => (
              <SettingsSection title={i18n.t("settings.localWorkspace.title")}>
                <Item>
                  <ItemContent>
                    <ItemTitle>{workspace().name}</ItemTitle>
                    <ItemDescription>{i18n.t("settings.localWorkspace.description")}</ItemDescription>
                  </ItemContent>
                </Item>
              </SettingsSection>
            )}
          </Show>
          <SettingsGeneralTab
            value={props.value}
            variant={props.appInfo?.variant ?? "production"}
            platform={props.appInfo?.platform}
            onUpdateSetting={updateSetting}
            onUpdateSettings={updateSettings}
            selectMount={modalElement}
          />
        </Tabs.Content>

        <Tabs.Content value="agents" class="settings-modal-tab-panel" data-tab="agents">
          {preferencesLoadError()}
          <agents.Panel menuMount={modalElement} />
        </Tabs.Content>

        <Tabs.Content value="notifications" class="settings-modal-tab-panel" data-tab="notifications">
          {preferencesLoadError()}
          <SettingsNotificationsTab
            value={props.value}
            onUpdateSetting={updateSetting}
            onUpdateSettings={updateSettings}
            onTestNotification={props.onTestNotification}
            onOpenNotificationSettings={
              props.appInfo?.platform === "darwin" || props.appInfo?.platform === "win32"
                ? props.onOpenNotificationSettings
                : undefined
            }
            levels={notificationLevels}
            onSetServerLevel={(serverId, level) =>
              props.onSetServerNotificationLevel?.(serverId, level) ?? Promise.resolve()
            }
            onSetServerMuted={(serverId, muted, durationMs) =>
              props.onSetServerMuted?.(serverId, muted, durationMs) ?? Promise.resolve()
            }
            focusRequest={props.notificationFocusRequest}
            menuMount={modalElement}
          />
        </Tabs.Content>

        <Tabs.Content value="voice" class="settings-modal-tab-panel" data-tab="voice">
          <SettingsVoiceTab store={voice} selectMount={modalElement} />
        </Tabs.Content>

        <Show when={dynamicIslandShown()}>
          <Tabs.Content value="dynamic-island" class="settings-modal-tab-panel" data-tab="dynamic-island">
            {preferencesLoadError()}
            <SettingsDynamicIslandTab
              value={props.value}
              variant={props.appInfo?.variant ?? "production"}
              builtInDisplayGeometry={props.builtInDisplayGeometry}
              servers={props.servers ?? []}
              onUpdateSetting={updateSetting}
              onUpdateSettings={updateSettings}
            />
          </Tabs.Content>
        </Show>

        <Tabs.Content value="computer-use" class="settings-modal-tab-panel" data-tab="computer-use">
          <ComputerUseSetup variant="settings" />
        </Tabs.Content>

        <Tabs.Content value="mobile-connect" class="settings-modal-tab-panel" data-tab="mobile-connect">
          <Show when={INDEPENDENT_EDITION}>
            <SettingsMobileConnectSetup
              variant={props.appInfo?.variant ?? "production"}
              account={props.selfHostedAccount}
              availability={mobileAccess.availability}
              loading={mobileAccess.loading}
              error={mobileAccess.error}
              onRefresh={() => void refreshMobileAccess()}
              onOpenAccount={(origin) =>
                void appPort()
                  .openUrl(new URL("/app", origin).href)
                  .catch((error) => {
                    const text = currentText();
                    setMobileAccess((draft) => {
                      draft.error = text.errorMessage(error, text.t("settings.mobileConnect.selfHosted.openFailed"));
                    });
                  })
              }
            />
          </Show>
          <Show when={mobileAccountKey()} keyed>
            {(_accountKey) => <SettingsMobileConnectPhones settings={props} active={mobileVisible()} />}
          </Show>
        </Tabs.Content>

        <Show when={!INDEPENDENT_EDITION}>
          <Tabs.Content value="profile" class="settings-modal-tab-panel profile-panel" data-tab="profile">
            <SettingsProfileTab
              store={profile}
              account={props.account}
              activity={profileActivity}
              canListSessions={Boolean(props.onListAccountSessions)}
              canRevokeSession={Boolean(props.onRevokeAccountSession)}
              onSignOut={props.onSignOut}
            />
          </Tabs.Content>

          <Tabs.Content value="billing" class="settings-modal-tab-panel" data-tab="billing">
            <BillingPanel
              store={billing}
              available={Boolean(props.billingApi)}
              hostedServers={hostedServers}
              onAddServer={hostedServers.state.available ? props.onAddHostedServer : undefined}
              license={
                <LicenseSection
                  store={license}
                  onManagePayment={() => void billing.openPortal({ flow: "manage" })}
                  onContactUs={licenseContactUs(props.onContactUs)}
                />
              }
            />
          </Tabs.Content>

          <Tabs.Content value="updates" class="settings-modal-tab-panel" data-tab="updates">
            {preferencesLoadError()}
            <SettingsUpdatesTab
              store={updates}
              onOpenWhatsNew={props.onOpenWhatsNew}
              value={props.value}
              onUpdateSetting={updateSetting}
              selectMount={modalElement}
            />
          </Tabs.Content>
        </Show>
      </SettingsDialogShell>
    </Tabs.Root>
  );
}

/** A new account gets a new store, so a prior account's QR code cannot survive sign-out. */
function SettingsMobileConnectPhones(props: { settings: SettingsModalProps; active: boolean }) {
  const store = createSettingsMobileConnectStore(props.settings, () => props.active);
  return (
    <SettingsMobileConnectTab
      store={store}
      canCreateTicket={Boolean(props.settings.onCreateMobileConnect)}
      canCancelTicket={Boolean(props.settings.onCancelMobileConnect)}
      canManageLink={Boolean(props.settings.onCreateMobileConnectLink && props.settings.onRevokeMobileConnectLink)}
      canRevokeDevice={Boolean(props.settings.onRevokeMobileConnectedDevice)}
      canSetRoute={Boolean(props.settings.onSetRemoteNetworkRoute)}
      showStoreLinks={!INDEPENDENT_EDITION}
    />
  );
}
