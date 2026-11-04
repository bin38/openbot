import type { ApiChannelRunSummary } from "@openbot/contracts/ipc";
import { ApiChannelRunHistory } from "@openbot/ui/features/settings/ApiChannelRunHistory";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const runs: ApiChannelRunSummary[] = [
  {
    id: "history-image",
    channelId: "minimax",
    channelName: "MiniMax",
    operationId: "image",
    operationName: "图片生成",
    status: "completed",
    createdAt: "2026-11-04T08:00:00.000Z",
    updatedAt: "2026-11-04T08:01:00.000Z",
    artifactCount: 2,
  },
  {
    id: "history-video",
    channelId: "minimax",
    channelName: "MiniMax",
    operationId: "video",
    operationName: "视频生成",
    status: "pending",
    createdAt: "2026-11-04T07:58:00.000Z",
    updatedAt: "2026-11-04T08:00:00.000Z",
    artifactCount: 0,
  },
  {
    id: "history-older",
    channelId: "removed-channel",
    channelName: null,
    operationId: "transcribe",
    operationName: "transcribe",
    status: "unknown",
    createdAt: null,
    updatedAt: null,
    artifactCount: 1,
  },
];

const meta = {
  title: "Settings/ApiChannelRunHistory",
  component: ApiChannelRunHistory,
  args: {
    channelName: null,
    filtered: false,
    runs,
    loading: false,
    openingId: null,
    error: null,
    onRefresh: fn(),
    onShowAll: fn(),
    onOpen: fn(),
  },
} satisfies Meta<typeof ApiChannelRunHistory>;

export default meta;
type Story = StoryObj<typeof meta>;
export const RecentResults: Story = {};
export const Empty: Story = { args: { runs: [] } };
export const Loading: Story = { args: { loading: true, runs: [] } };
export const FilteredChannel: Story = {
  args: { channelName: "MiniMax", filtered: true, runs: runs.filter((run) => run.channelId === "minimax") },
};
