import type { ApiChannelDefinition } from "@openbot/contracts/ipc";
import { ApiChannelEditor } from "@openbot/ui/features/settings/ApiChannelEditor";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const definition: ApiChannelDefinition = {
  name: "Example API",
  description: "A configurable HTTP operation",
  baseUrl: "https://api.example.test",
  auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
  headers: [],
  artifactHosts: [],
  operations: [
    {
      id: "recognize",
      name: "Recognize text",
      description: "Extract text from an image URL",
      method: "POST",
      path: "/ocr",
      bodyType: "json",
      body: JSON.stringify({ image: "{{image_url}}" }, null, 2),
      query: [],
      parameters: [
        { name: "image_url", type: "string", required: true, description: "Public image URL", defaultJson: "" },
      ],
      readOnly: false,
      response: {
        format: "json",
        resultPath: "text",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
  ],
};

const meta = {
  title: "Settings/ApiChannelEditor",
  component: ApiChannelEditor,
  parameters: { layout: "fullscreen" },
  args: {
    definition,
    existing: null,
    onValidate: fn(async () => definition),
    onSave: fn(async () => undefined),
    onClose: fn(),
  },
} satisfies Meta<typeof ApiChannelEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewEndpoint: Story = {};
export const SavedCredential: Story = {
  args: {
    existing: {
      id: "story-api",
      definition,
      enabled: true,
      source: "user",
      credentialStatus: "saved",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
  },
};
export const AssistantDraft: Story = {
  args: {
    existing: {
      id: "story-draft",
      definition,
      enabled: false,
      source: "agent",
      credentialStatus: "missing",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
  },
};
