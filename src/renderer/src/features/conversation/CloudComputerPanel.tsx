import type { E2bSettings } from "@openbot/contracts/ipc";
import { CloudComputerPanel as SharedCloudComputerPanel } from "@openbot/ui/features/conversation/CloudComputerPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, onSettled, untrack } from "solid-js";
import { readPanelWidth, savePanelWidth } from "../../components/panel-width-storage";
import { visibleCloudComputerOverlay } from "./cloud-computer-viewport";
import { conversationPort } from "./conversation-port";

const WIDTH_KEY = "openbot:cloud-computer-panel-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 1600;
const PREVIEW_INTERVAL_MS = 2000;

interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CloudComputerPanelProps {
  agentId: string;
  suspended: boolean;
  onConfigure?: ((trigger: HTMLElement) => void) | undefined;
  onClose: () => void;
  defaultWidth: () => number;
  maxWidth: () => number;
  onWidthChange: (width: number) => void;
}

/** One mounted agent pane owns one preview loop and, after explicit takeover, one native viewer. */
export default function CloudComputerPanel(props: CloudComputerPanelProps) {
  const { t, errorMessage } = useText();
  const agentId = untrack(() => props.agentId);
  const api = conversationPort().e2b;
  const [state, setState] = createStore<{
    settings: E2bSettings | null;
    busy: "load" | "start" | "pause" | "takeover" | "handback" | "refresh" | null;
    error: string | null;
    preview: string | null;
    viewerOpen: boolean;
  }>({ settings: null, busy: "load", error: null, preview: null, viewerOpen: false });
  const [documentHidden, setDocumentHidden] = createSignal(document.hidden);
  const initialWidth = readPanelWidth(WIDTH_KEY, untrack(props.defaultWidth), MIN_WIDTH, MAX_WIDTH);
  const [width, setWidth] = createSignal(initialWidth);
  const machine = () => state.settings?.machines.find((item) => item.agentId === agentId) ?? null;
  const suspended = () => props.suspended || documentHidden();
  let viewport: HTMLDivElement | undefined;
  let alive = true;
  let generation = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewPending = false;
  let frameRequest = 0;
  let framePending = false;
  let lastFrame = "";

  const defaultWidth = () => Math.round(Math.min(props.maxWidth(), Math.max(MIN_WIDTH, props.defaultWidth())));
  const resize = (next: number) => setWidth(Math.round(Math.min(props.maxWidth(), Math.max(MIN_WIDTH, next))));
  const resizeFromStorage = () => resize(readPanelWidth(WIDTH_KEY, defaultWidth(), MIN_WIDTH, MAX_WIDTH));
  createEffect(
    () => ({ width: width(), changed: props.onWidthChange }),
    (next) => {
      // A Solid setter returns its value even when the callback type is void. Effects may only
      // return a cleanup function, so do not forward the parent's setter result.
      next.changed(next.width);
    },
  );

  /** The native view must not cover dialogs, menus, or a page that has left the foreground. */
  function bounds(): ViewportBounds | null {
    if (!viewport || suspended() || visibleCloudComputerOverlay() || viewport.closest("[inert]")) return null;
    const rect = viewport.getBoundingClientRect();
    const x = Math.max(0, Math.round(rect.left));
    const y = Math.max(0, Math.round(rect.top));
    const width = Math.min(window.innerWidth, Math.round(rect.right)) - x;
    const height = Math.min(window.innerHeight, Math.round(rect.bottom)) - y;
    return width >= 1 && height >= 1 ? { x, y, width, height } : null;
  }

  async function publishFrame() {
    frameRequest = 0;
    if (!alive || !state.viewerOpen || framePending) return;
    const frame = bounds();
    const key = JSON.stringify(frame);
    if (key === lastFrame) return;
    framePending = true;
    lastFrame = key;
    try {
      await api.setViewerBounds({ agentId, bounds: frame });
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("server.cloudComputer.failed"));
        });
    } finally {
      framePending = false;
      // Coalesce resize events while the previous IPC was pending.
      if (alive && state.viewerOpen && JSON.stringify(bounds()) !== lastFrame) scheduleFrame();
    }
  }

  function scheduleFrame() {
    if (alive && frameRequest === 0) frameRequest = requestAnimationFrame(() => void publishFrame());
  }

  createEffect(
    () => ({ suspended: suspended(), viewerOpen: state.viewerOpen, width: width() }),
    () => scheduleFrame(),
  );

  async function readSettings(expectedGeneration = generation) {
    const settings = await api.getSettings();
    if (!alive || expectedGeneration !== generation) return;
    const current = settings.machines.find((item) => item.agentId === agentId);
    setState((draft) => {
      draft.settings = settings;
      if (current?.control !== "human") draft.viewerOpen = false;
      if (current?.state !== "running" || current.control === "human") draft.preview = null;
    });
  }

  function schedulePreview(delay = PREVIEW_INTERVAL_MS) {
    if (!alive) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void poll(), delay);
  }

  /** There is at most one capture request. The next one is scheduled only after this one settles. */
  async function poll() {
    previewTimer = undefined;
    if (!alive || previewPending) return;
    if (suspended() || state.busy) {
      schedulePreview();
      return;
    }
    previewPending = true;
    const request = generation;
    try {
      await readSettings(request);
      const current = machine();
      if (
        !alive ||
        generation !== request ||
        suspended() ||
        current?.state !== "running" ||
        current.control !== "agent"
      )
        return;
      const screenshot = await api.preview({ agentId });
      if (alive && generation === request && !suspended())
        setState((draft) => {
          draft.preview = `data:${screenshot.mimeType};base64,${screenshot.base64}`;
          draft.error = null;
        });
    } catch (error) {
      if (alive && generation === request) {
        setState((draft) => {
          draft.error = errorMessage(error, t("server.cloudComputer.failed"));
        });
        // E2B can pause at its own deadline. Reconcile the saved state after a capture fails.
        await api
          .status({ agentId })
          .then(() => readSettings(request))
          .catch(() => undefined);
      }
    } finally {
      previewPending = false;
      schedulePreview();
    }
  }

  async function run(kind: NonNullable<typeof state.busy>, operation: () => Promise<void>) {
    if (state.busy && state.busy !== "load") return;
    generation += 1;
    setState((draft) => {
      draft.busy = kind;
      draft.error = null;
    });
    try {
      await operation();
      await readSettings();
    } catch (error) {
      if (alive)
        setState((draft) => {
          draft.error = errorMessage(error, t("server.cloudComputer.failed"));
        });
    } finally {
      if (alive) {
        setState((draft) => {
          draft.busy = null;
        });
        schedulePreview(0);
        scheduleFrame();
      }
    }
  }

  function takeover() {
    const frame = bounds();
    if (!frame) return;
    void run("takeover", async () => {
      await api.takeover({ agentId, bounds: frame });
      if (!alive) {
        await api.closeViewer({ agentId });
        return;
      }
      lastFrame = "";
      setState((draft) => {
        draft.viewerOpen = true;
        draft.preview = null;
      });
    });
  }

  function handback() {
    void run("handback", async () => {
      await api.handback({ agentId });
      if (alive)
        setState((draft) => {
          draft.viewerOpen = false;
        });
    });
  }

  onSettled(() => {
    void run("load", async () => undefined);
    const resizeObserver = new ResizeObserver(scheduleFrame);
    if (viewport) resizeObserver.observe(viewport);
    const mutations = new MutationObserver(scheduleFrame);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["inert", "hidden", "open", "aria-hidden", "data-state"],
    });
    const visibility = () => {
      setDocumentHidden(document.hidden);
      scheduleFrame();
      if (!document.hidden) schedulePreview(0);
    };
    window.addEventListener("resize", scheduleFrame);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      generation += 1;
      if (previewTimer) clearTimeout(previewTimer);
      if (frameRequest) cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", scheduleFrame);
      document.removeEventListener("visibilitychange", visibility);
      // Main checks window ownership; this cannot close another window's viewer or change its control.
      void api.closeViewer({ agentId }).catch(() => undefined);
    };
  });

  return (
    <SharedCloudComputerPanel
      machine={machine()}
      credentialStatus={state.settings?.credentialStatus ?? null}
      pending={state.settings?.pendingAgentIds.includes(agentId) ?? false}
      busy={state.busy}
      error={state.error}
      preview={state.preview}
      viewerOpen={state.viewerOpen}
      suspended={suspended()}
      width={width()}
      defaultWidth={defaultWidth()}
      minWidth={MIN_WIDTH}
      maxWidth={props.maxWidth}
      onWidthChange={resize}
      onSaveWidth={(next) => savePanelWidth(WIDTH_KEY, next)}
      onParentResize={resizeFromStorage}
      onResetWidth={() => {
        window.localStorage.removeItem(WIDTH_KEY);
        resize(defaultWidth());
      }}
      onViewport={(element) => {
        viewport = element;
      }}
      onStart={() =>
        void run("start", async () => {
          await api.start({ agentId });
        })
      }
      onPause={() =>
        void run("pause", async () => {
          await api.pause({ agentId });
        })
      }
      onRefresh={() =>
        void run("refresh", async () => {
          if (machine()) await api.status({ agentId });
        })
      }
      onTakeover={takeover}
      onHandback={handback}
      onConfigure={props.onConfigure}
      onClose={props.onClose}
    />
  );
}
