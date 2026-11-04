import type { E2bMachine } from "@openbot/contracts/ipc";
import { CloudComputerPanel } from "@openbot/ui/features/conversation/CloudComputerPanel";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const machine: E2bMachine = {
  agentId: "cloud-computer-story",
  sandboxId: "preview-desktop",
  state: "paused",
  control: "agent",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
};

const meta = {
  title: "Conversation/CloudComputerPanel",
  component: CloudComputerPanel,
  args: {
    machine,
    credentialStatus: "saved",
    pending: false,
    busy: null,
    error: null,
    preview: null,
    viewerOpen: false,
    suspended: false,
    width: 480,
    defaultWidth: 480,
    minWidth: 280,
    maxWidth: () => 900,
    onWidthChange: fn(),
    onSaveWidth: fn(),
    onResetWidth: fn(),
    onParentResize: fn(),
    onViewport: fn(),
    onStart: fn(),
    onPause: fn(),
    onRefresh: fn(),
    onTakeover: fn(),
    onHandback: fn(),
    onConfigure: fn(),
    onClose: fn(),
  },
  render: (args) => {
    const [width, setWidth] = createSignal(args.width);
    return (
      <div class="conversation-panel" style={`height: 100vh; --browser-panel-width: ${width()}px`}>
        <CloudComputerPanel {...args} width={width()} onWidthChange={setWidth} />
      </div>
    );
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CloudComputerPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Paused: Story = {};
export const NeedsSetup: Story = { args: { machine: null, credentialStatus: "missing" } };
export const Creating: Story = { args: { machine: null, busy: "start", pending: true } };
export const ReadingDesktop: Story = { args: { machine: { ...machine, state: "running" } } };
export const HumanControl: Story = { args: { machine: { ...machine, state: "running", control: "human" } } };
