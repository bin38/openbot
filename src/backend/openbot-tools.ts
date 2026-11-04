import {
  CHAT_VISUAL_CONTEXT_LIMIT,
  CHAT_VISUAL_HTML_LIMIT,
  CHAT_VISUAL_MAX_HEIGHT,
  CHAT_VISUAL_MIN_HEIGHT,
  CHAT_VISUAL_TITLE_LIMIT,
} from "@openbot/contracts/chat-visual";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { API_KEY_NAME_PATTERN, CONNECTOR_IDS } from "@openbot/contracts/ipc";
import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { isUiBlockId, UI_BLOCK_LIMITS } from "@openbot/contracts/ui-blocks";
import { z } from "zod";
import pluginCatalog from "../../resources/plugin-catalog/catalog.json";
import { advertisedJsonSchema } from "./agent/advertised-json-schema";
import { interruptAgentToolSchema } from "./agent/agent-interrupt-tool";
import { API_CHANNEL_TOOL_DEFINITIONS } from "./agent/api-channel-tools";
import { DATA_TOOL_DEFINITIONS } from "./agent/data-tools";
import { E2B_TOOL_DEFINITIONS } from "./agent/e2b-tools";
import { HISTORY_TOOL_DEFINITIONS } from "./agent/history-tools";
import { MCP_SERVER_TOOL_DEFINITIONS } from "./agent/mcp-tools";
import { MEMORY_RECALL_TOOL_DEFINITIONS } from "./agent/memory-tool-inputs";
import {
  createAgentToolSchema,
  listModelsToolSchema,
  readAgentToolSchema,
  updateAgentsToolSchema,
  updateProfileToolSchema,
} from "./agent/profile-tools";
import { ROUTINE_NO_UPDATE_TOOL, ROUTINE_REPORT_FAILURE_TOOL } from "./agent/routine-quiet-runs";
import { captureScreenToolShape } from "./agent/screen-capture";
import {
  assignAgentSectionToolSchema,
  createSectionToolSchema,
  deleteSectionToolSchema,
  renameSectionToolSchema,
} from "./agent/sidebar-tools";
import { LOCAL_SKILL_TOOL_DEFINITIONS } from "./agent/skill-tools";
import { CREATE_WEBHOOK_ROUTINE_TOOL, UPDATE_WEBHOOK_ROUTINE_TOOL } from "./agent/webhook-routine-tool";
import { START_TASK_TOOL, startTaskToolSchema } from "./agent-tasks/agent-tasks";
import {
  AWAIT_EVENT_TOOL,
  awaitEventToolSchema,
  CLOSE_WAIT_TOOL,
  closeWaitToolSchema,
  LIST_WAITS_TOOL,
  listWaitsToolSchema,
} from "./agent-waits/agent-waits";
import { CHANNEL_TOOL_DEFINITIONS } from "./channel-tools";
import { MESSAGING_TOOL_DEFINITIONS } from "./messaging/messaging-tools";
import { ROUTINE_FLOW_TOOL_DEFINITIONS } from "./routine-flows/routine-flow-tools";
import {
  ROUTINE_INSTRUCTION_RULE,
  routineInstructionZodSchema,
  routineLimitPolicyZodSchema,
  routineMissedPolicyZodSchema,
  routineScheduleZodSchema,
  webhookEventTypeZodSchema,
  webhookFiltersZodSchema,
} from "./routine-tool-schema";

interface OpenBotToolDefinition {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

/** The page rules for `html_render` and `html_preview`. The names match the variables that `ChatVisual` sends. */
const VISUAL_PAGE_RULES = [
  "Write self-contained HTML with inline <style> and <script>. Remote http(s) files, including CDN libraries, load unchanged; local paths do not load.",
  "The sandbox blocks cookies, storage and pop-ups. Clicked http(s) links open in the user's browser.",
  "The borderless frame shares the chat background and reply-column width (about 360px on phones). Use transparent html/body, fluid width, no outer card or banner title: this is part of your reply.",
  "Set fixed pixel heights for charts and content-based page height; no 100vh or height:100% on html/body. The frame clips outside the page box: highlight with borders, not outlines or outer shadows.",
  "OpenBot sets :root CSS variables from the app theme (dark on desktop): --background (transparent), --foreground, --muted-foreground, --muted, --card, --card-foreground, --border, --accent, --destructive, --success, --chart-1 to --chart-6, --radius, --font-sans, --font-mono. Base body font and color use them.",
].join(" ");

/** What an `html_render` page can ask of the app. The names match `window.openbotPage` in the frame bootstrap. */
const VISUAL_PAGE_ACTIONS = [
  "For a choice, form or game, call openbotPage.sendMessage(text) on click to fill the user's message box; the user sends it.",
  `On click, openbotPage.setContext(text) quotes page state in the message box for you to read next; at most ${CHAT_VISUAL_CONTEXT_LIMIT} characters, empty text removes it.`,
  "OpenBot supplies full-screen and image enlargement; do not build them. Mobile runs scripts without openbotPage: check window.openbotPage before calling it.",
].join(" ");

export const htmlRenderToolSchema = z.object({
  html: z.string().min(1).max(CHAT_VISUAL_HTML_LIMIT).describe("A complete, self-contained HTML document."),
  title: z.string().trim().min(1).max(CHAT_VISUAL_TITLE_LIMIT).describe("A short name for the page."),
  height: z
    .number()
    .int()
    .min(CHAT_VISUAL_MIN_HEIGHT)
    .max(CHAT_VISUAL_MAX_HEIGHT)
    .optional()
    .describe(
      `Maximum frame height in CSS pixels, ${CHAT_VISUAL_MIN_HEIGHT}-${CHAT_VISUAL_MAX_HEIGHT}. Omit to fit the page.`,
    ),
});

const CHAT_VISUAL_PREVIEW_MIN_WIDTH = 240;
const CHAT_VISUAL_PREVIEW_MAX_WIDTH = 1_600;
/** The width of the reply column in a desktop chat. */
export const CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH = 728;

export const htmlPreviewToolSchema = z.object({
  html: z.string().min(1).max(CHAT_VISUAL_HTML_LIMIT).describe("A complete, self-contained HTML document."),
  width: z
    .number()
    .int()
    .min(CHAT_VISUAL_PREVIEW_MIN_WIDTH)
    .max(CHAT_VISUAL_PREVIEW_MAX_WIDTH)
    .optional()
    .describe(
      `Width in CSS pixels, ${CHAT_VISUAL_PREVIEW_MIN_WIDTH}-${CHAT_VISUAL_PREVIEW_MAX_WIDTH}. Default ${CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH} (desktop reply); use 360 for phones.`,
    ),
  appearance: z.enum(["dark", "light"]).optional().describe("App theme; default dark."),
});

// `ask_ui` input. The limits are the contract's; `normalizeUiBlockSpec` then checks the rules a schema
// cannot say, such as unique ids and option labels. An id passes the same check as a stored block id.
const uiBlockIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9.:-][A-Za-z0-9_.:-]{0,63}$/)
  .refine(isUiBlockId, "Use another id: botId, recipientBotId, recipientBotIds and senderBotId are reserved.")
  .describe("1-64 letters, digits, _ . : -; no initial _.");
const uiTextSchema = (max: number) => z.string().min(1).max(max);
const uiLabelSchema = uiTextSchema(UI_BLOCK_LIMITS.label);
const uiActionSchema = z.strictObject({
  id: uiBlockIdSchema,
  label: uiLabelSchema,
  style: z.enum(["primary", "secondary", "ghost", "danger"]).optional().describe("The default is secondary."),
  confirm: z.boolean().optional().describe("Desktop/web ask again before sending. Plain-question clients do not."),
});
const uiOptionSchema = z.strictObject({ id: uiBlockIdSchema, label: uiLabelSchema });
const uiStringOptionsSchema = (max: number) => z.array(uiLabelSchema).min(1).max(max);
const uiFormFieldBase = { id: uiBlockIdSchema, required: z.boolean().optional() };
const uiFormTextField = (kind: "text" | "textarea") =>
  z.strictObject({
    ...uiFormFieldBase,
    kind: z.literal(kind),
    label: uiLabelSchema,
    placeholder: uiLabelSchema.optional(),
    value: z.string().max(UI_BLOCK_LIMITS.fieldValue).optional(),
    ...(kind === "text"
      ? {
          secret: z.boolean().optional().describe("Password/key: hidden, not stored. Do not supply a value."),
        }
      : {}),
  });
const uiFormOptionsField = (kind: "select" | "segmented", max: number) =>
  z.strictObject({
    ...uiFormFieldBase,
    kind: z.literal(kind),
    label: uiLabelSchema.optional(),
    options: uiStringOptionsSchema(max),
    value: uiLabelSchema.optional().describe("One of options."),
  });

export const routineReportFailureToolSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.routineFailureReason)
    .describe("Why the task failed, in one short sentence."),
});

/** `acknowledge_request`: the action ids of its plan card. */
export const ACKNOWLEDGE_REQUEST_ACTIONS = { start: "start", alternative: "alternative", cancel: "cancel" } as const;

export const acknowledgeRequestToolSchema = z.object({
  message: uiTextSchema(UI_BLOCK_LIMITS.title).describe(
    "Briefly acknowledge the task and name the work, e.g. On it. Here is my staging 502 plan.",
  ),
  steps: z
    .array(
      z.strictObject({
        label: uiLabelSchema.describe("Such as First or Then."),
        step: uiTextSchema(UI_BLOCK_LIMITS.text).describe("Action in one line."),
      }),
    )
    .min(1)
    .max(4),
  startLabel: uiLabelSchema.describe("Start button label."),
  cancelLabel: uiLabelSchema.describe("Cancel button label."),
  alternativeLabel: uiLabelSchema.optional().describe("Smaller alternative, e.g. Only find the cause."),
});

export const askUiToolSchema = z.object({
  blockId: uiBlockIdSchema.optional().describe("Block id; generated if omitted."),
  block: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("confirm"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      danger: z.boolean().optional().describe("Danger styling; hold the primary button to press."),
      confirmHold: z.number().int().min(UI_BLOCK_LIMITS.holdMinMs).max(UI_BLOCK_LIMITS.holdMaxMs).optional(),
      fields: z
        .array(
          z.union([
            z.strictObject({ label: uiLabelSchema, value: z.string().max(UI_BLOCK_LIMITS.text) }),
            z.strictObject({
              label: uiLabelSchema,
              select: uiBlockIdSchema.describe("Chosen option key in values, not action."),
              options: uiStringOptionsSchema(UI_BLOCK_LIMITS.selectOptions).describe("First is default."),
            }),
          ]),
        )
        .max(UI_BLOCK_LIMITS.confirmFields)
        .optional(),
      preview: uiTextSchema(UI_BLOCK_LIMITS.preview).optional().describe("Markdown, e.g. a letter body."),
      actions: z.array(uiActionSchema).min(1).max(UI_BLOCK_LIMITS.actions),
    }),
    z.strictObject({
      type: z.literal("quick_replies"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title).optional(),
      options: z.array(uiOptionSchema).min(1).max(UI_BLOCK_LIMITS.quickReplies),
      allowText: z.boolean().optional().describe("Allow a free-text reply."),
    }),
    z.strictObject({
      type: z.literal("choice"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      multiple: z.boolean().optional(),
      options: z
        .array(
          z.strictObject({
            id: uiBlockIdSchema,
            label: uiLabelSchema,
            meta: uiTextSchema(UI_BLOCK_LIMITS.meta).optional(),
            selected: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(UI_BLOCK_LIMITS.choiceOptions),
      submit: uiLabelSchema.optional().describe("The submit button label."),
    }),
    z.strictObject({
      type: z.literal("form"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      fields: z
        .array(
          z.discriminatedUnion("kind", [
            uiFormTextField("text"),
            uiFormTextField("textarea"),
            uiFormOptionsField("select", UI_BLOCK_LIMITS.selectOptions),
            uiFormOptionsField("segmented", UI_BLOCK_LIMITS.segmentedOptions),
            z.strictObject({
              ...uiFormFieldBase,
              kind: z.literal("date"),
              label: uiLabelSchema,
              value: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .describe("YYYY-MM-DD."),
            }),
          ]),
        )
        .min(1)
        .max(UI_BLOCK_LIMITS.formFields),
      submit: uiLabelSchema.optional().describe("The submit button label."),
    }),
  ]),
});

const apiKeyNameSchema = z
  .string()
  .regex(API_KEY_NAME_PATTERN)
  .describe("Key variable, e.g. OPENAI_API_KEY: A-Z, 0-9, _, at most 64 characters.");

export const requestApiKeyToolSchema = z.strictObject({
  name: apiKeyNameSchema,
  title: uiTextSchema(UI_BLOCK_LIMITS.title).describe(
    "Key purpose in the user's language, e.g. OpenAI key for the image script.",
  ),
  placeholder: uiLabelSchema.optional().describe("Field hint, e.g. sk-…. Never a real key."),
  submit: uiLabelSchema.optional().describe("The submit button label."),
});

export const removeApiKeyToolSchema = z.strictObject({ name: apiKeyNameSchema });

export const sendToChannelToolSchema = z.strictObject({
  channelId: z.string().min(1).max(INPUT_LIMITS.identifier),
  text: z.string().trim().min(1).max(INPUT_LIMITS.messageText),
  recipientAgentIds: z.array(z.string().min(1).max(INPUT_LIMITS.identifier)).max(INPUT_LIMITS.agents).optional(),
  paths: z.array(z.string().min(1).max(INPUT_LIMITS.path)).max(INPUT_LIMITS.attachments).optional(),
});

/** The Marketplace apps that the chat draws a card for: the bundled catalog plugins and the connectors. */
export const MARKETPLACE_APP_IDS: readonly string[] = [
  ...pluginCatalog.plugins.map((plugin) => plugin.slug),
  ...CONNECTOR_IDS,
];

/** Shared declarations for Codex, Grok, and Claude. Service handlers enforce execution rules. */
const ALL_OPENBOT_TOOL_DEFINITIONS: readonly OpenBotToolDefinition[] = [
  ...CHANNEL_TOOL_DEFINITIONS,
  ...MESSAGING_TOOL_DEFINITIONS,
  ...HISTORY_TOOL_DEFINITIONS,
  ...DATA_TOOL_DEFINITIONS,
  ...LOCAL_SKILL_TOOL_DEFINITIONS,
  ...ROUTINE_FLOW_TOOL_DEFINITIONS,
  ...MCP_SERVER_TOOL_DEFINITIONS,
  ...E2B_TOOL_DEFINITIONS,
  ...API_CHANNEL_TOOL_DEFINITIONS,
  {
    name: "list_sites",
    description:
      "List the static sites of this OpenBot server, with its site limit and the slots in use. Use this before retrying a hosting mutation.",
    shape: {},
  },
  {
    name: "publish_site",
    description:
      "Publish a new static site after the user explicitly asks to publish it. The source must be inside this agent's workspace or OpenBot Shared.",
    shape: {
      sourcePath: z.string().min(1).max(INPUT_LIMITS.path),
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      spaFallback: z.boolean().optional(),
    },
  },
  {
    name: "replace_site",
    description:
      "Replace an owned static site after the user explicitly asks to replace it. This keeps the URL and resets expiry to 30 days.",
    shape: {
      siteId: z.string().min(1).max(INPUT_LIMITS.identifier),
      sourcePath: z.string().min(1).max(INPUT_LIMITS.path),
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      spaFallback: z.boolean().optional(),
    },
  },
  {
    name: "delete_site",
    description: "Delete an owned static site after the user explicitly asks to delete it.",
    shape: { siteId: z.string().min(1).max(INPUT_LIMITS.identifier) },
  },
  {
    name: "attach_files_to_response",
    description:
      "Attach existing local deliverables (screenshots, charts, diagrams, reports, ZIPs or other files) to this response. OpenBot copies each file and shows image previews in chat.",
    shape: { paths: z.array(z.string().min(1).max(INPUT_LIMITS.path)).min(1).max(INPUT_LIMITS.attachments) },
  },
  {
    name: "html_preview",
    description: `Preview HTML privately: get a screenshot, content height and console output. Check and correct the page before html_render. ${VISUAL_PAGE_RULES}`,
    shape: htmlPreviewToolSchema.shape,
  },
  {
    name: "html_render",
    description: `Show finished HTML (chart, table, diagram, collage, mockup) above your final reply; call before writing it. Add only what the page does not say; do not announce or repeat it. All channel readers see it. The frame fits the page; a lower height caps it with scrolling. ${VISUAL_PAGE_RULES} ${VISUAL_PAGE_ACTIONS}`,
    shape: htmlRenderToolSchema.shape,
  },
  {
    name: "list_capture_sources",
    description:
      "List the displays and windows of this computer that capture_screen can capture: display ids, desktop bounds in points, scale factors, and window ids and titles.",
    shape: {},
  },
  {
    name: "capture_screen",
    description:
      "Capture one display, one window, or a region of one display of this computer, and get the image. The user approves each capture first, and sees the image in this conversation. In a channel, each member who reads the channel sees it. Call list_capture_sources first to get ids and bounds. A region uses desktop points.",
    shape: captureScreenToolShape,
  },
  {
    name: "list_sections",
    description:
      "List sidebar sections (folders), their stable ids, and agent assignments before choosing message recipients or grouping agents.",
    shape: {},
  },
  {
    name: "create_section",
    description:
      "Create a sidebar section (folder) to group existing agents. List sections first and reuse an existing matching section.",
    shape: createSectionToolSchema.shape,
  },
  {
    name: "rename_section",
    description: "Rename an existing custom sidebar section.",
    shape: renameSectionToolSchema.shape,
  },
  {
    name: "delete_section",
    description: "Delete a custom sidebar section without deleting its agents; its agents become ungrouped.",
    shape: deleteSectionToolSchema.shape,
  },
  {
    name: "assign_agent_section",
    description: "Move an existing agent into a sidebar section. Pass null for sectionId to ungroup it.",
    shape: assignAgentSectionToolSchema.shape,
  },
  {
    name: "list_channels",
    description:
      "List the open channels with their id, name, lead, and members. A sidebar section (folder) is not a channel.",
    shape: {},
  },
  {
    name: "send_to_channel",
    description:
      "Post a request into a channel when the user gives it work. Members do not see this conversation: write the whole brief. paths attaches local files. recipientAgentIds names members; without it, the lead chooses. No result comes back here. In a channel task, use channel_assign or channel_transfer.",
    shape: sendToChannelToolSchema.shape,
  },
  {
    name: "list_agents",
    description:
      "List local agents: name, title, description (300 characters; read_agent has all), status (working/queued/ready), queuedMessages, turnStartedAt while working, lastActivityAt and openWaits. Match work outside your remit to titles/descriptions. Changed files are not tracked.",
    shape: {},
  },
  {
    name: "list_models",
    description:
      "List the models each provider offers: id, name, reasoning efforts, and the default model that create_agent uses for a provider only. With no query, each provider lists its default, the models in use and its first models; omittedModels counts the rest. A provider with more than one account lists them: id, label and state, its own sign-in (id default) first. Read-only.",
    shape: listModelsToolSchema.shape,
  },
  {
    name: "interrupt_agent",
    description:
      "Stop another agent's current turn when that turn works on your message, and cancel your requests still queued for it. The agent receives a notice from you with the reason. You cannot stop work that the user, a routine, a channel, or another agent started. To give new work, call send_message after this tool.",
    shape: interruptAgentToolSchema.shape,
  },
  {
    name: "read_agent",
    description:
      "Read the setup of one local OpenBot agent, or your own when you omit agentId: profile, provider, model, reasoning effort, account, backup models, the model it returns to after a usage limit or a provider error, access, Computer Use, notifications, auto-approve, installed skills, routines, and the MCP servers it gets. Read-only. Call it before you change another agent.",
    shape: readAgentToolSchema.shape,
  },
  {
    name: "create_agent",
    description:
      "Create a persistent local OpenBot agent when the user asks for a new teammate. Choose its profile from the user's request and supply its first task. The new agent gets your provider, model, and reasoning effort. Set provider, model, or reasoningEffort only when the user asks for different ones; call list_models first. Use update_profile for an existing agent. After it exists, add skills with install_local_skill and routines with create_routine as needed. A new agent gets your own access and Computer Use limits.",
    shape: createAgentToolSchema.shape,
  },
  {
    name: "update_profile",
    description:
      "Update a local agent's name, title, description, avatar, provider, model, effort, account, backups, access, Computer Use or notifications as requested. You may restrict writes to workspace or disable Computer Use; only the user can widen them. For local/uploaded images, use avatarPath; prepare a PNG, JPEG or WebP copy up to 512 KB if needed. Call list_models before model, account or backup changes. Models apply next turn. Provider/account changes fail during a turn or with queued messages; retry when ready. backupModels replaces the list. Use update_agents for shared settings.",
    shape: updateProfileToolSchema.shape,
  },
  {
    name: "update_agents",
    description:
      "Apply the same requested provider, model, effort, access, Computer Use or notifications setting to several local agents. Each is checked and changed in sequence as in update_profile; failures do not stop or undo others. Returns updated/failed counts and each id's ok/settings or error. Unlisted providers/models fail the whole call. Report failed agents and reasons. You may restrict writes to workspace or disable Computer Use; only the user can widen them. Call list_models before model changes.",
    shape: updateAgentsToolSchema.shape,
  },
  {
    name: "start_new_chat",
    description:
      "Start a new chat for yourself when this chat is long and its earlier messages no longer matter, or when a routine asks for it. Each message then sends less context. Before you call it, keep what you need: use remember, or write notes to a file in your workspace. The user still sees the earlier messages; you do not. The new chat starts when this turn ends and your queue is empty. When a queued message runs in this chat first, the request ends; call it again if you still need it. It works only in your own chat, and only when the user allows it in your settings.",
    shape: {},
  },
  {
    name: "list_routines",
    description:
      "List routines for this agent, or for another local agent when agentId is provided. Use this before updating or deleting a routine. routines has the schedule routines; webhookRoutines has the webhook routines with their event type, filters and URL.",
    shape: { agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional() },
  },
  {
    name: "create_routine",
    description:
      "Create a scheduled routine for this agent, or for another local agent when agentId is provided. It is active by default. Without a timezone, it uses the timezone of the person whose message this turn answers, or the server timezone when that is unknown. Interval, advanced-every, and custom schedules must not run more often than every 3 minutes. For a one-time reminder or task, use a once schedule: it runs one time and then pauses the routine. When watching a folder for new files and no interval was requested, use a 15 minute interval and keep the folder path plus handling instructions in the routine instruction.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      name: z.string().min(1).max(INPUT_LIMITS.routineName),
      instruction: routineInstructionZodSchema,
      schedule: routineScheduleZodSchema.describe(
        "Routine schedule. Interval, advanced-every, and custom schedules must not run more often than every 3 minutes.",
      ),
      active: z.boolean().optional(),
      timezone: z.string().min(1).max(128).describe("IANA timezone such as Europe/Warsaw.").optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
      missedPolicy: routineMissedPolicyZodSchema.optional(),
    },
  },
  {
    name: CREATE_WEBHOOK_ROUTINE_TOOL,
    description:
      "Create a routine that a signed HTTP request starts, for this agent or for another local agent when agentId is provided. Use it when the user wants work to start when something happens in another system. It works only in a turn that a person's message started, not in a routine run or for an agent's message. It is active by default. The result has the webhook URL and the request format. The signing secret is not in the result; the result says where the user gets it. Never ask the user for the secret. A null url means the URL is not ready yet; the Routines settings show it when it is.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      name: z.string().min(1).max(INPUT_LIMITS.routineName),
      instruction: z
        .string()
        .min(1)
        .max(INPUT_LIMITS.routineInstruction)
        .describe(
          `What to do with each request. OpenBot adds the request body to the run as untrusted data. ${ROUTINE_INSTRUCTION_RULE}`,
        ),
      eventType: webhookEventTypeZodSchema.optional(),
      filters: webhookFiltersZodSchema.optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
    },
  },
  {
    name: UPDATE_WEBHOOK_ROUTINE_TOOL,
    description:
      "Change a webhook routine of this agent, or of another local agent when agentId is provided: its event type, filters, name, instruction, or pause and resume it. Get its routineId from webhookRoutines of list_routines. Fields you leave out keep their saved values; filters replaces the whole list, and an empty list removes all filters. The URL and the signing secret stay the same. It works only in a turn that a person's message started.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
      name: z.string().min(1).max(INPUT_LIMITS.routineName).optional(),
      instruction: z.string().min(1).max(INPUT_LIMITS.routineInstruction).optional(),
      eventType: webhookEventTypeZodSchema.optional(),
      filters: webhookFiltersZodSchema.optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
    },
  },
  {
    name: "update_routine",
    description:
      "Update, pause, or resume an existing routine for this agent, or for another local agent when agentId is provided. Fields you leave out keep their saved values. Replacement schedules must not run more often than every 3 minutes. A one-time routine that already ran resumes only with a new once schedule in the future. The result is the saved routine. For a webhook routine, use update_webhook_routine.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
      name: z.string().min(1).max(INPUT_LIMITS.routineName).optional(),
      instruction: routineInstructionZodSchema.optional(),
      schedule: routineScheduleZodSchema
        .describe("Routine schedule. Must not run more often than every 3 minutes.")
        .optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
      missedPolicy: routineMissedPolicyZodSchema.optional(),
    },
  },
  {
    name: "delete_routine",
    description: "Delete an existing routine for this agent, or for another local agent when agentId is provided.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
    },
  },
  {
    name: "test_routine",
    description:
      "Queue one manual test run of an existing routine for this agent, or for another local agent when agentId is provided.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
    },
  },
  {
    name: ROUTINE_NO_UPDATE_TOOL,
    description:
      "Use only in scheduled, script or webhook runs with nothing to report: collapse the run's text in chat and send no notification; retain run history. Do not use when reporting. Requested reminders/messages are reports: write them in your final answer unless the task's notification conditions require silence. Manual Test runs show your answer.",
    shape: {},
  },
  {
    name: ROUTINE_REPORT_FAILURE_TOOL,
    description:
      "Use only when a routine task could not be done, e.g. a required server/file/service is unavailable. End the run as failed with your reason in history; still answer as usual. Do not use for completed tasks, including bad-news results.",
    shape: routineReportFailureToolSchema.shape,
  },
  {
    name: AWAIT_EVENT_TOOL,
    description:
      "Open a wait when you cannot finish the current request in this turn because you wait for something outside it: a build, a deploy, a later check. OpenBot shows the wait to the user until you close it. The next run of one of your routines wakes the wait, or a local script event that names its waitId. The run that wakes it repeats the request and your note. Give routineId to let only that routine wake it. After this call, tell the user what you wait for and end your turn.",
    shape: awaitEventToolSchema.shape,
  },
  {
    name: CLOSE_WAIT_TOOL,
    description:
      "Close an open wait when its request is done, or when it can no longer be done. Leave it open to wait for the next run again. Give agentId to close a finished wait of another local agent.",
    shape: closeWaitToolSchema.shape,
  },
  {
    name: LIST_WAITS_TOOL,
    description:
      "List your open waits, or another local agent's when you give agentId: waitId, note, openedAt, routineId (null: any of its routines wakes it), and wokenAt. Use it to find and close waits whose request is done. Read-only.",
    shape: listWaitsToolSchema.shape,
  },
  {
    name: START_TASK_TOOL,
    description:
      "Start a task: a separate conversation of yours that runs beside this chat, with its own context, progress and stop. Use it only for long, independent work that the user asked for and that need not block this chat. The brief is the task's first message: write everything the task needs, because it does not see this chat. The task result stays in the task; you do not receive it. Only your own chat can start a task.",
    shape: startTaskToolSchema.shape,
  },
  ...MEMORY_RECALL_TOOL_DEFINITIONS,
  {
    name: "remember",
    description:
      "Stage one short durable memory; use memoryId to correct/merge one. New entries are searchable unless inclusion is essential; essential entries that do not fit stay searchable. Commit only when this turn completes.",
    shape: {
      text: z.string().min(1).max(INPUT_LIMITS.agentMemoryText),
      memoryId: z.string().optional(),
      inclusion: z.enum(["essential", "searchable"]).optional(),
    },
  },
  {
    name: "forget_memory",
    description:
      "Stage deletion of one memory on user request, or when stale/merged and space is needed under the limit. Commit only when this turn completes.",
    shape: { memoryId: z.string().min(1) },
  },
  {
    name: "ask_user",
    description:
      "Ask 1–3 short questions and await structured answers. Use for clarification or choices instead of questions in normal messages.",
    shape: {
      questions: z
        .array(
          z.strictObject({
            id: z.string().max(INPUT_LIMITS.identifier).optional(),
            header: z.string().max(INPUT_LIMITS.promptHeader).optional(),
            question: z.string().min(1).max(INPUT_LIMITS.promptQuestion),
            isSecret: z
              .boolean()
              .optional()
              .describe(
                "Mask private answers, e.g. one-time codes. For API keys/tokens use request_api_key to keep them out of your context.",
              ),
            options: z
              .array(
                z.strictObject({
                  label: z.string().min(1).max(INPUT_LIMITS.promptOptionLabel),
                  description: z.string().max(INPUT_LIMITS.promptOptionDescription).optional(),
                }),
              )
              .max(INPUT_LIMITS.promptOptions)
              .optional(),
          }),
        )
        .min(1)
        .max(3),
    },
  },
  {
    name: "acknowledge_request",
    description: [
      "Before a long task, show the user a short acknowledgement and your plan in one card, and wait for the answer.",
      "Call it first, before other tools, when the work takes more than about a minute: a fix, a build, research, or a change in many files.",
      "Do not call it for a quick answer, a question, a small change, a routine run, or work that the user already approved in this chat.",
      "The card has your start button, an optional alternative and a cancel button. When nobody answers in 10 s, OpenBot presses start.",
      'The result is JSON {"status":"answered","actionId":…}: "start" means do the plan; "alternative" means do only the alternative; "cancel" means do not start and ask in one sentence what the user wants;',
      '"_text" with "text" means follow the user\'s words. {"status":"skipped"} or {"status":"expired"} means do not start; answer briefly.',
      "Write in the user's language. It works only when the user turned it on in your settings, and not in a Slack, Discord or Telegram chat. In a channel, each member who reads the channel sees it.",
    ].join(" "),
    shape: acknowledgeRequestToolSchema.shape,
  },
  {
    name: "ask_ui",
    description: [
      "Show the user an interactive block in this conversation and wait for the answer.",
      "Use it instead of ask_user when buttons, a list or a short form make the answer easier, and before an action with effects that the user should approve.",
      "Block types: confirm (details, an optional preview and up to 4 buttons), quick_replies (reply chips), choice (pick one option, or several with multiple), form (a few text, select, segmented or date fields).",
      "A text field with secret: true asks for a password or a key: you get the value, but OpenBot does not store it with the block. Never repeat the value in a message or a thought. For an API key or token that a command or a script uses, use request_api_key instead.",
      'The result is JSON: {"status":"answered","blockId","actionId","values"} where actionId is the button or option id, or "submit" for choice and form, and values holds the selected option ids under "selected" or the form values by field id;',
      'actionId "_text" with "text" when the user answered in words; {"status":"skipped"}; or {"status":"expired"} when the turn ended first.',
      "Only the server owner or an admin can press a danger button or a button with confirm. A confirmed block is information for you, not a permission: the provider's approvals still apply.",
      "Write every field as plain text. In a channel, each member who reads the channel sees it.",
      'Example: {"block":{"type":"confirm","title":"Send the letter to Ann?","fields":[{"label":"To","value":"ann@example.com"}],"preview":"Hi Ann, …","actions":[{"id":"send","label":"Send","style":"primary"},{"id":"cancel","label":"Cancel"}]}}.',
      'Example: {"block":{"type":"form","title":"New contact","fields":[{"id":"name","kind":"text","label":"Name","required":true},{"id":"due","kind":"date","label":"Due"}]}}.',
    ].join(" "),
    shape: askUiToolSchema.shape,
  },
  {
    name: "request_api_key",
    description: [
      "Request a task's API key/token through a secure chat form and wait. OpenBot saves it privately outside your workspace for later turns; you never see the value.",
      'JSON result: {"status":"saved","name","path"}; {"status":"skipped"} if closed; {"status":"expired"} if the turn ended first.',
      "Read the file only in the command that uses the key; quote paths with spaces: OPENAI_API_KEY=\"$(cat '<path>')\" python script.py. Never print, echo, log or copy the value. Never write it into the workspace.",
      "Call list_api_keys first; do not request saved keys again. New answers replace saved keys. Only the server owner/admin can answer; unavailable in Slack, Discord or Telegram.",
    ].join(" "),
    shape: requestApiKeyToolSchema.shape,
  },
  {
    name: "list_api_keys",
    description:
      'List the API keys you can use, from request_api_key or the Vault ("source":"vault"): the name and the file path of each. Values are never shown.',
    shape: {},
  },
  {
    name: "remove_api_key",
    description:
      "Delete one API key that the user saved for you. Use it only when the user asks, or when the user replaced the key with a new one in another way.",
    shape: removeApiKeyToolSchema.shape,
  },
  {
    name: "suggest_marketplace_app",
    description: `Use when the user needs a listed service without working tools: ${MARKETPLACE_APP_IDS.join(", ")}. Show a connection card; only the user can connect. For installed apps, test and return the fix (Sign in card or setup steps).`,
    shape: {
      app: z.string().min(1).max(63).describe("An app from the list, such as notion. Use github for GitHub."),
    },
  },
  {
    name: "react_to_user_message",
    description:
      "React once with an emoji to clear emotion: wins, affection, gratitude, humor, sadness, disappointment, frustration, empathy or strong approval. An answer emoji is not a reaction. Skip neutral messages; still give the normal answer.",
    shape: { emoji: z.string().min(1).max(64).describe("Exactly one complete Unicode emoji.") },
  },
  {
    name: "send_message",
    description:
      "Queue an async message and optional local files for agents. Set replyToMessageId to the original message id when replying. Set expectsReply false for information that needs no answer.",
    shape: {
      recipientAgentIds: z.array(z.string()).min(1).max(32),
      text: z.string().min(1).max(100_000),
      paths: z.array(z.string()).max(10).optional(),
      replyToMessageId: z.string().nullable().optional(),
      expectsReply: z
        .boolean()
        .describe(
          "Default true: requests/questions/tasks get a reply via OpenBot. False: information (status, notice, task reply) that the recipient may act on but must not answer; ends the exchange.",
        )
        .optional(),
    },
  },
];

const UPSTREAM_HOSTING_TOOLS = new Set(["list_sites", "publish_site", "replace_site", "delete_site"]);
export function isUpstreamHostingTool(name: string): boolean {
  return UPSTREAM_HOSTING_TOOLS.has(name);
}
export const OPENBOT_TOOL_DEFINITIONS = ALL_OPENBOT_TOOL_DEFINITIONS.filter(
  (definition) => !INDEPENDENT_EDITION || !isUpstreamHostingTool(definition.name),
);

export const OPENBOT_DYNAMIC_TOOLS = {
  type: "namespace",
  name: "openbot",
  description:
    "Attach files to the current response, keep structured data in the shared SQLite database, and work with persistent OpenBot teammates.",
  tools: OPENBOT_TOOL_DEFINITIONS.map((definition) => ({
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    inputSchema: advertisedJsonSchema(z.strictObject(definition.shape)),
  })),
} as const;
