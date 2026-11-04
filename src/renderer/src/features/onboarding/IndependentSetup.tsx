import type { AgentModelId, AgentProviderId, AppSetupState, DesktopPlatform } from "@openbot/contracts/ipc";
import { Button, ErrorReference, Heading, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { ComputerUseSetup } from "../computer-use/ComputerUseSetup";
import {
  createSetupProviders,
  SetupProviderPicker,
  type SetupProviderProps,
  savedCustomModel,
} from "./SetupProviderPicker";
import { createSetupNext } from "./setup-next";

interface IndependentSetupProps extends SetupProviderProps {
  state: AppSetupState;
  platform: DesktopPlatform;
  workspaceName: string;
  onSave: (provider: AgentProviderId, model?: AgentModelId | null) => Promise<void>;
  onProviderStepShown?: () => void;
}

/** A local workspace selects its own model connection, without an upstream account or sales flow. */
export function IndependentSetup(props: IndependentSetupProps) {
  const { t, errorMessage } = useText();
  const saved = untrack(() => props.state);
  const providers = createSetupProviders(props, {
    provider: saved.preferredProvider ?? "codex",
    customModel: () => savedCustomModel(saved.preferredProvider, saved.preferredModel, props.customProviders),
  });
  const next = createSetupNext(providers);
  const [saving, setSaving] = createSignal(false);
  const [mount, setMount] = createSignal<HTMLElement | undefined>();
  createEffect(
    () => props.onProviderStepShown,
    (scan) => {
      scan?.();
    },
  );

  async function openWorkspace(): Promise<void> {
    if (saving()) return;
    if (!providers.selectedProviderConnected()) {
      next.connectSelected();
      return;
    }
    const provider = providers.selectedProvider();
    if (!provider) return;
    setSaving(true);
    providers.clearErrors();
    try {
      await props.onSave(
        provider,
        providers.customSelected()
          ? providers.customModel()
          : saved.preferredProvider === provider
            ? saved.preferredModel
            : null,
      );
    } catch (error) {
      providers.setError(errorMessage(error, t("onboarding.setup.saveFailed")), error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main class="initial-setup-screen">
      <section class="initial-setup" ref={setMount} aria-label={t("onboarding.local.title")}>
        <Heading as="h1" size="lg">
          {t("onboarding.local.title")}
        </Heading>
        <Text tone="muted">{props.workspaceName}</Text>
        <Text>{t("onboarding.local.description")}</Text>
        <SetupProviderPicker
          providers={providers}
          ariaLabel={t("onboarding.provider.defaultLabel")}
          label={t("onboarding.provider.label")}
          hint={t("onboarding.provider.hintChange")}
          disabled={saving()}
          menuMount={mount()}
        />
        <Show when={props.platform === "darwin"}>
          <ComputerUseSetup variant="compact" />
        </Show>
        <Show when={providers.error()}>
          {(error) => (
            <Text tone="danger" role="alert">
              {error()}
              <ErrorReference reference={providers.errorReference()} />
            </Text>
          )}
        </Show>
        <Button loading={saving()} onClick={() => void openWorkspace()}>
          {t("onboarding.local.open")}
        </Button>
        <Show when={next.blockedReason()}>
          {(reason) => (
            <Text variant="caption" tone="muted">
              {reason()}
            </Text>
          )}
        </Show>
      </section>
    </main>
  );
}
