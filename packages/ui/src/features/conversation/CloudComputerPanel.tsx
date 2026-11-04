import type { E2bMachine, E2bSettings } from "@openbot/contracts/ipc";
import { Button, Cloud, Pause, Play, RefreshCw, Settings, Spinner, Text, X } from "@openbot/ui";
import { PanelResizer } from "@openbot/ui/components/PanelResizer";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";

export interface CloudComputerPanelProps {
  machine: E2bMachine | null;
  credentialStatus: E2bSettings["credentialStatus"] | null;
  pending: boolean;
  busy: "load" | "start" | "pause" | "takeover" | "handback" | "refresh" | null;
  error: string | null;
  preview: string | null;
  viewerOpen: boolean;
  suspended: boolean;
  width: number;
  defaultWidth: number;
  minWidth: number;
  maxWidth: () => number;
  onWidthChange: (width: number) => void;
  onSaveWidth: (width: number) => void;
  onResetWidth: () => void;
  onParentResize: () => void;
  onViewport: (element: HTMLDivElement) => void;
  onStart: () => void;
  onPause: () => void;
  onRefresh: () => void;
  onTakeover: () => void;
  onHandback: () => void;
  onConfigure?: ((trigger: HTMLButtonElement) => void) | undefined;
  onClose: () => void;
}

/** The desktop renderer supplies a read-only preview or places an isolated native view in the stage. */
export function CloudComputerPanel(props: CloudComputerPanelProps) {
  const { t } = useText();
  const running = () => props.machine?.state === "running";
  const human = () => props.machine?.control === "human";
  const ready = () => props.credentialStatus === "saved";
  const status = () => {
    if (!props.machine) return t(props.pending ? "server.cloudComputer.pending" : "server.cloudComputer.noMachine");
    if (human()) return t("server.cloudComputer.humanControl");
    switch (props.machine.state) {
      case "running":
        return t("conversation.cloudComputer.agentControl");
      case "paused":
        return t("server.cloudComputer.paused");
      case "missing":
        return t("server.cloudComputer.missing");
      case "unknown":
        return t("server.cloudComputer.unknown");
    }
  };
  const emptyTitle = () => {
    if (!ready()) return t("conversation.cloudComputer.configureTitle");
    if (props.machine?.state === "paused") return t("conversation.cloudComputer.pausedTitle");
    if (human()) return t("conversation.cloudComputer.continueTitle");
    if (running()) return t("conversation.cloudComputer.waitingFrame");
    return t("conversation.cloudComputer.emptyTitle");
  };
  const emptyDescription = () => {
    if (!ready()) return t("conversation.cloudComputer.configureDescription");
    if (props.machine?.state === "paused") return t("conversation.cloudComputer.pausedDescription");
    if (human()) return t("conversation.cloudComputer.continueDescription");
    return t("conversation.cloudComputer.emptyDescription");
  };

  return (
    <aside
      class="browser-panel cloud-computer-panel"
      id="cloud-computer-panel"
      aria-label={t("conversation.sidePanel.pane.cloudComputer")}
    >
      <PanelResizer
        class="right-panel-resizer"
        label={t("conversation.cloudComputer.resize")}
        controls="cloud-computer-panel"
        direction="right"
        value={props.width}
        defaultValue={props.defaultWidth}
        min={props.minWidth}
        max={props.maxWidth}
        onResize={props.onWidthChange}
        onResizeEnd={props.onSaveWidth}
        onParentResize={props.onParentResize}
        onReset={props.onResetWidth}
      />
      <header class="file-preview-header side-panel-pane-header">
        <h2 class="side-panel-pane-title">{t("conversation.sidePanel.pane.cloudComputer")}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          class="side-panel-pane-close"
          aria-label={t("conversation.sidePanel.closePanel")}
          onClick={() => props.onClose()}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div class="cloud-computer-toolbar">
        <Text variant="caption" role="status">
          {status()}
        </Text>
        <div class="cloud-computer-actions">
          <Show when={!running() && !human()}>
            <Button
              size="sm"
              disabled={!ready() || Boolean(props.busy)}
              loading={props.busy === "start"}
              onClick={() => props.onStart()}
            >
              <Play aria-hidden="true" />
              {props.machine || props.pending ? t("server.cloudComputer.resume") : t("server.cloudComputer.create")}
            </Button>
          </Show>
          <Show when={running() && !human()}>
            <Button
              size="sm"
              disabled={!ready() || Boolean(props.busy) || props.suspended}
              loading={props.busy === "takeover"}
              onClick={() => props.onTakeover()}
            >
              {t("server.cloudComputer.takeover")}
            </Button>
          </Show>
          <Show when={human()}>
            <Show when={!props.viewerOpen}>
              <Button
                size="sm"
                disabled={!ready() || Boolean(props.busy) || props.suspended}
                loading={props.busy === "takeover"}
                onClick={() => props.onTakeover()}
              >
                {t("conversation.cloudComputer.continueControl")}
              </Button>
            </Show>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(props.busy)}
              loading={props.busy === "handback"}
              onClick={() => props.onHandback()}
            >
              {t("server.cloudComputer.handback")}
            </Button>
          </Show>
          <Show when={running() && !human()}>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={Boolean(props.busy)}
              loading={props.busy === "pause"}
              aria-label={t("server.cloudComputer.pause")}
              title={t("server.cloudComputer.pause")}
              onClick={() => props.onPause()}
            >
              <Pause aria-hidden="true" />
            </Button>
          </Show>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={Boolean(props.busy)}
            aria-label={t("server.cloudComputer.refresh")}
            title={t("server.cloudComputer.refresh")}
            onClick={() => props.onRefresh()}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          <Show when={props.onConfigure}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("conversation.cloudComputer.configure")}
              title={t("conversation.cloudComputer.configure")}
              onClick={(event) => props.onConfigure?.(event.currentTarget)}
            >
              <Settings aria-hidden="true" />
            </Button>
          </Show>
        </div>
      </div>
      <Show when={props.error}>
        {(error) => (
          <Text class="cloud-computer-notice" variant="caption" tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <div class="cloud-computer-stage" ref={(element) => props.onViewport(element)}>
        <Show
          when={!human() && props.preview}
          fallback={
            <div class="cloud-computer-empty">
              <Show
                when={props.busy === "load" || (running() && !human() && !props.error)}
                fallback={<Cloud aria-hidden="true" />}
              >
                <Spinner label={t("common.loading")} />
              </Show>
              <strong>{emptyTitle()}</strong>
              <p>{emptyDescription()}</p>
              <Show when={!ready() && props.onConfigure}>
                <Button variant="outline" onClick={(event) => props.onConfigure?.(event.currentTarget)}>
                  {t("conversation.cloudComputer.configure")}
                </Button>
              </Show>
            </div>
          }
        >
          {(preview) => (
            <img
              class="cloud-computer-preview"
              src={preview()}
              alt={t("conversation.cloudComputer.previewAlt")}
              draggable={false}
            />
          )}
        </Show>
      </div>
      <Text class="cloud-computer-notice" variant="caption" tone="muted">
        {human() ? t("conversation.cloudComputer.humanHint") : t("conversation.cloudComputer.agentHint")}
      </Text>
    </aside>
  );
}
