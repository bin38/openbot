import { Button, Heading, ItemActions, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { type JSX, Portal } from "@solidjs/web";
import { createMemo, Errored, Show } from "solid-js";

interface FeaturePanelBoundaryProps {
  /** Construct the feature and its conditional props only inside the error boundary's owner. */
  render: () => JSX.Element;
  onClose: () => void;
  /** A settings page uses its existing content mount. No mount means that page is closed. */
  fallbackMount?: (() => HTMLElement | undefined) | undefined;
  sidePanel?: boolean;
}

function FailureNotice(props: { onRetry: () => void; onClose: () => void; sidePanel: boolean }) {
  const { t } = useText();
  return (
    <section
      class={props.sidePanel ? "browser-panel side-panel-empty" : "settings-modal-tab-panel server-settings-panel"}
      data-selected=""
      role="alert"
      aria-label={t("settings.panelError.title")}
    >
      <div class={props.sidePanel ? "side-panel-launcher" : "settings-modal-content"}>
        <Heading size="sm">{t("settings.panelError.title")}</Heading>
        <Text as="p" tone="muted">
          {t("settings.panelError.description")}
        </Text>
        <ItemActions>
          <Button
            type="button"
            onClick={() => {
              props.onRetry();
            }}
          >
            {t("settings.panelError.retry")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              props.onClose();
            }}
          >
            {t("settings.panelError.close")}
          </Button>
        </ItemActions>
      </div>
    </section>
  );
}

function FailurePlacement(props: {
  onRetry: () => void;
  onClose: () => void;
  mount: () => HTMLElement | undefined;
  portaled: () => boolean;
  sidePanel: () => boolean;
}) {
  // The placement can itself be a conditional parent prop. Resolve it in this component's
  // owned computation, not while an Errored callback is deciding which fallback to construct.
  const placement = createMemo(() => ({
    mount: props.mount(),
    portaled: props.portaled(),
    sidePanel: props.sidePanel(),
  }));
  return (
    <Show
      when={placement().portaled}
      fallback={<FailureNotice onRetry={props.onRetry} onClose={props.onClose} sidePanel={placement().sidePanel} />}
    >
      <Show when={placement().mount}>
        {(mount) => (
          <Portal mount={mount()}>
            <FailureNotice onRetry={props.onRetry} onClose={props.onClose} sidePanel={placement().sidePanel} />
          </Portal>
        )}
      </Show>
    </Show>
  );
}

/** Contains feature errors without resetting application data or exposing exceptions to the page. */
export function FeaturePanelBoundary(props: FeaturePanelBoundaryProps) {
  return (
    <Errored
      fallback={(_error, reset) => (
        <FailurePlacement
          onRetry={reset}
          onClose={() => {
            props.onClose();
          }}
          mount={() => props.fallbackMount?.()}
          portaled={() => props.fallbackMount !== undefined}
          sidePanel={() => props.sidePanel === true}
        />
      )}
    >
      {props.render()}
    </Errored>
  );
}
