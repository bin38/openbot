# Privacy — independent local edition

The desktop starts with a local owner and a loopback host. It does not need an upstream OpenBot
account. The original account, billing, hosted-server purchase, hosted-site publication, automatic
application update, analytics, and error-reporting services are disabled in the default local setup.
An existing upstream account session is not loaded as the local identity. Its files are preserved.

The host's local SQLite database and files remain the source of truth for agents, conversations,
attachments, browser data, and team data. Selected conversation context still goes to the model
provider. Plugins, visited pages, explicit remote connections, and optional E2B computers use the
network as described below. Local Codex uses its existing CLI sign-in; OpenBot does not copy that
credential into an account service or into E2B.

This notice covers the independent desktop defaults. Browser access, account services, messaging
relays, and mobile are separate optional surfaces. The retained mobile app has not been migrated
to an account-free independent client; its account, push, analytics, and file-transfer setup need
separate configuration and validation. Descriptions of those paths below apply only when those
services are explicitly used. They are not started by `bun run dev`.

## Optional E2B cloud computers

When you configure your own E2B key and create a cloud computer, E2B hosts that computer's
filesystem, desktop, browser sessions, and command execution. Commands, typed input, and files
selected for cloud transfer go directly from this OpenBot host to E2B. Screenshots, command output,
and downloaded files return to this host and can be used by the agent's model provider. These
transfers do not go through the OpenBot account service.

The host encrypts the E2B key with operating-system secure storage. Its local E2B state file keeps
the encrypted key, template, timeout, and per-agent machine identifiers and control state. Neither
the key nor the authenticated desktop-viewer URL is included in the renderer's settings snapshot,
conversation tool results, or telemetry. The viewer has its own temporary browser session, no
OpenBot preload, no local-file access, and no permission to open external windows.

Taking control blocks new agent computer actions, including screenshots and file access, until
control is returned. Returning control stops the authenticated viewer. Pausing preserves E2B
state; deleting a cloud computer removes its cloud files. Closing OpenBot does not delete the VM:
E2B's configured timeout pauses it. Removing the saved key does not delete or stop cloud resources.
The agent process still runs on the OpenBot host, so an E2B computer alone does not make local
agents run while that host is off.

## File uploads

Desktop imports accept regular files of any type. Local imports copy and hash on disk. Updated
desktop/browser connections transfer bounded chunks to the selected host and verify offsets and
SHA-256 before publishing an attachment. Temporary uploads are removed after a failed or cancelled
transfer. This path has no application file-size quota; disk, filesystem, provider, and per-message
file-count limits still apply. The account service does not receive these file contents.

Uploading a file does not execute it or automatically extract an archive. Unknown formats stay
opaque files; an agent may inspect them with its own tools. Older hosts retain their released
limits, and mobile retains its existing 10 MB native bridge. Archive import and skill installation
have separate extraction limits. See [cloud computers and files](docs/cloud-computers-and-files.md).

## 自定义 API 端点与任务结果

此功能把请求直接发送给你配置的 API 服务，不经过原 OpenBot 账号服务。被调用的服务会收到操作所需的文本、
参数，以及你指定上传的工作区文件；这些数据受该服务的处理规则约束。multipart 直接流式发送所选文件，JSON
端点可把所选文件编码为 data URI 或 Base64，内嵌文件总量保护上限为 16 MiB。API 自身的格式、时长和大小限制
仍然适用，例如 MiniMax ASR 当前单次最多 50 MB、500 秒。

请求定义、公共字段和默认参数保存在本机配置中。实际密钥单独加密，并把它允许使用的 origin 一起绑定在加密
记录中；修改到另一个 origin 不能继续沿用原密钥。应用不会在设置读取结果、API 工具结果或诊断日志中返回已保存
密钥，也不会将它作为工具参数交给模型。不要把秘密放入公共模板、参数默认值或普通聊天消息。

助手可以根据文档创建新的停用草稿，但不能通过该工具启用渠道、填写保存的密钥或修改已有渠道。用户检查配置、
保存凭据并启用后，助手按已保存的操作和现有审批策略调用。它不能在一次调用中覆盖基础地址、鉴权或操作定义。
指定文件通过既有工作区路径和文件句柄检查，系统不会仅凭助手提供的任意主机路径读取文件。

API 任务、结果及产物元数据加密保存在当前应用 profile 中。模型和界面可以收到经过脱敏的结果、任务 ID 和附件
信息。下载 URL、内联音频或图像会在私有任务记录或产物缓存中处理；产物下载不转发渠道鉴权或 Cookie，也不自动
跟随重定向。跨 origin 的产物主机必须符合渠道的下载允许列表。生成文件先保存在本机私有缓存，用户下载或助手
交付后，可保存到用户选择的位置或作为受管理的对话附件。它们不会因为删除渠道配置就自动从既有对话中删除。

无法确认远端执行结果的请求会保留为“结果未知”，不会自动重发生成请求，避免重复计费或重复修改远端数据。
关闭 OpenBot 或中断本地请求并不保证取消已由服务商接受的异步任务；远端任务是否能取消取决于对应 API。
添加 API 端点不会改变本机 Codex 默认模型、现有 CPA 模型渠道或它们的登录凭据。

MiniMax 的订阅用量查询使用独立配置的官方 origin；订阅 Key 与按量 Key 不能混用。预置模板不是权限证明，
音乐接口仅作历史付费兼容，WebSocket 实时会话未由这组 HTTP 模板实现。
详见[API 端点说明](docs/minimax-api-channels.md)和 [MiniMax 订阅规则](https://platform.minimax.cn/docs/m-plan/faq)。

## Plugins, public Registry, and local catalogs

The desktop ships with 35 app entries, including X, X Account, Feishu, and GitHub MCP. These entries
configure supported services; they do not copy Codex's private connector backend. X and GitHub MCP
send the user's token to their official endpoints. X Account uses the official local `xurl` bridge
and the user's own developer application. Feishu uses the official `lark-mcp` package with the
user's application credentials; personal-user OAuth is a separate setup. Each service receives
the requests and data required by the tools the user enables, under that service's policy and
permissions. A service can impose its own usage charges.

Public MCP directory search sends the query and paging parameters to
`registry.modelcontextprotocol.io`. Public metadata is cached on the host. Browsing does not start
a package or connect to a listed MCP server. The user reviews the endpoint or pinned package,
provides credentials, and tests the connection before enabling it. Package installation can contact
npm and the publisher's dependencies. Registry cache files contain public metadata, not values
entered in credential fields.

Static MCP headers and environment variables use the existing host-local SQLite storage. They are
redacted from logs but are not OS-encrypted by this change. MCP OAuth grants use the existing
encrypted grant store. The E2B API key uses a separate encrypted store. Host access controls and the
provider's execution permissions still matter; these stores do not isolate secrets from an agent
that has unrestricted access to the host.

Agent, template, and skill discovery/publication records use this profile's local catalog.
Snapshots can contain instructions, routines, avatars, and selected skill text; they do not include
workspace files or conversation memories. Copied `openbot://` links refer to local records and do
not upload data to a public site. Cross-device sharing needs a separate export or an explicitly
configured service. See [independent plugins](docs/independent-plugins.md).

## Browser client

This path requires an explicitly configured account/host service; it is not the local desktop
startup. The optional browser client at `/app` connects to the computer that runs OpenBot. Conversation
and attachment data travel through the existing encrypted host connection, not through the
account Worker. The browser keeps chat pages, drafts, search results, and file previews in memory;
it does not create a persistent offline chat cache. Files that the user downloads are saved by
their browser. The host must stay online. An owner or admin can manage members and invitations from
the browser; these requests go to the account Worker, as they do from the desktop app. A signed-in
user can also change the display name and avatar and disconnect account sessions from the browser;
these requests and the avatar image go to the same account Worker as from the desktop app. Host
settings, such as MCP servers, travel through the encrypted host connection. Original hosted-site
publication is disabled in this edition; the local catalog does not send templates or skills to
the account Worker.
A Grok Bot export that a member imports into a joined server, from the desktop app or the browser, goes
to the computer that runs that server through the same encrypted host connection, not through the
account Worker. The host keeps the file only until the import ends, is cancelled, or expires.
When an owner or admin signs in to an MCP server, a provider or a connector of a joined server, or
opens a sign-in link that an agent of that server showed, the sign-in page can open in the browser
of their own computer. That computer then sends the address the page returns to, which holds the
sign-in code, to the host through the same encrypted host connection, not through the account
Worker. A Slack or Discord install sends its sealed grant to the host on the same path; the user's
computer cannot open it. Neither computer logs the code, and the host keeps the grant.
When a member of a joined server selects "Sign in on this computer" in that server's browser, the
desktop app opens the site in a window on their computer, with a session in memory only. When the
window finds a completed sign-in, or when the member selects Done, it sends the cookies of that site,
and of no other site, to the host through the same encrypted host connection, not through the account
Worker. The host sets them in the browser session of the tab: the shared session, which every agent
and member of the server can use, the session of an agent that has a browser session of its own, or
a named browser profile, which every agent assigned to that profile can use.
When the server tab still shows a sign-in step, the app also sends the address of the window's page,
and the server tab opens it.
Neither computer logs the cookie values. The desktop app then removes the window's session.
To show each server's state, the browser also keeps a status connection to each host of the account
that no tab has open, as the mobile app does; the host then shows the member as present. Host logos
come from the account Worker to members of the host, and the browser can cache them.

Browser email sign-in uses a persistent host-only `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
Browser JavaScript cannot read the account credential. Trusted host public keys are stored in
local storage separately for each account. The shared file preview can also store its panel width.
The sidebar stores pinned agent and channel ids, collapsed section ids, and the selected channel id
for each account and host. The server rail stores the order of host ids for each account. The
browser also stores the chosen interface language and whether the completion sound is on. It stores
no message content.
Signing out revokes that credential's remote sessions and tells other open tabs to clear private
state. Host identity pins remain so a later sign-in cannot silently trust a replacement host key.
The independent web client has no default telemetry collector. A separately configured collector
uses the limits in [Product analytics](#product-analytics). The original account-service sales,
email, revenue, and Signal metrics are not part of the local desktop runtime. Retained backend or
public-site deployments have their own configuration and require a separate privacy review before
an operator enables them.

## AI conversation context

When a provider session is replaced, OpenBot sends a bounded excerpt of the current conversation
to the selected provider. The agent can request older messages from that same conversation through
local history tools. Requested text and selected saved work steps are then sent to that provider.
These tools exclude messages before the latest context reset and cannot search another conversation.
Channel history keeps its existing membership and task checks. Messaging history stays within its
current link. The full conversation stays in local SQLite storage. No history text is sent to the
account service or analytics by these tools.

## Local scripts

Local scripts is off by default for each agent. When enabled, scripts that run as the same OS user
on the host can read a local token and use the loopback API. They can send messages, run routines,
read pending questions and approvals, and submit answers or approval decisions. OpenBot redacts
secrets in API responses. Secret questions and browser takeovers return notices only and must be
completed in OpenBot. OpenBot does not send these API responses to the account service or analytics.
A script can send the data elsewhere under its own configuration.

## Agent and host usage

The Usage view stores numeric token counts, activity counts, provider and model identifiers,
internal session and turn identifiers, timestamps, and cost estimates in the host's local SQLite
database. Collection starts when this feature is installed. It does not import old provider
transcripts or store message contents, credentials, or raw provider responses in analytics records.

Authenticated members of a host team can read aggregate usage for that host's agents through the
Team API, including from mobile. Desktop can also show the combined totals for all agents on one
host, with an optional agent filter. A host-wide response carries the combined totals, one row per
day, one row per model, one aggregate row per agent, identified by the agent's internal id, and one
row per day and provider with that provider's token count and cost estimate for the day. Agent
names are not part of the analytics payload; the client shows them from the agent list it already
reads. These records stay on the host and are not stored by the account service or Signal
service. An explicitly configured telemetry collector can receive bounded token-count events as
described below; no collector is active by default. Conversation clearing retains usage;
agent deletion removes it. A duplicate agent starts with no usage history.

Authenticated members of a host team can also see that host's storage through the Team API: how
much disk space each location, agent and chat uses, and the name, size, type, date and chat title of
each sent or generated file. They can also read the free and total size of the disk that holds the
host's OpenBot data. The response contains no file paths, and workspace and download files
are counted only as totals. Only owners and admins can delete a file or clear caches and logs. A
deleted file is removed from the host's disk; the message that sent it stays and shows that the file
is not available.

Costs are API-equivalent estimates in USD, not subscription charges. Missing usage, unknown prices,
and incomplete billing inputs remain marked as unavailable or partial.

## Product analytics

The independent desktop and browser client send no product analytics to an upstream collector by
default, including anonymous install events. The host does not create its analytics client or
failure-report queue unless an operator supplies an explicit capture endpoint. Renderer telemetry
also needs that explicit endpoint. A saved preference from an older install does not restore the
original collector. The shared report transport has no default endpoint and rejects the original
product domains.

If an operator explicitly configures a collector, the retained event schema can send application
version, platform, provider/model, action categories, counts, timing, results, and coarse failure
codes. Host events can include token counts, routine/workflow outcomes, installed feature counts,
and bounded resource summaries. When tracking is enabled, website events can include the visited
registrable domain, and tool events can include supported tool/plugin categories. They exclude
conversation text, prompts, replies, file contents, local paths, command text, raw errors,
credentials, and arbitrary MCP arguments/results. Session replay and automatic interaction capture
are disabled.

A configured collector can receive a random install ID. With an explicitly signed-in account and
account-linked tracking enabled, it can also receive that account's ID and normalized email as
profile data. The tracking preference controls that account link; it is not a promise to stop all
basic events once an operator has enabled a collector. Remove the collector configuration to stop
these sends. The collector receives the network address and may derive connection metadata. Its
operator controls retention; local changes cannot recall events already delivered.

Local usage history, trace files, and resource measurements can remain on this computer even when
no telemetry is sent. They support the Usage view and manual diagnostics exports.

The retained mobile app, public website, account Worker, and Signal service have separate analytics
configuration. This desktop change does not certify those deployments as telemetry-free. Review
[mobile configuration](apps/mobile/README.md) and the deployed service settings before using them.

## Data stored by an optional account service

No central service receives account data in the default local edition. To enable an account
service, the operator must set `OPENBOT_SELF_HOSTED_API_URL` to their own HTTPS origin, or an HTTP
loopback origin for development. Credentials, query strings, and paths are rejected, and the
original product origin is not used. Saved account and team state is scoped to that origin;
changing origins does not reuse an account session from another service.

A separately deployed account service can store account IDs, normalized email addresses, names,
avatars, email-code challenge hashes, session-token hashes, rate-limit records, host identities,
memberships, invitations, and logical remote sessions. If remote features are enabled, it can also
store routing metadata and serve avatars or host logos. The retained implementation uses
Cloudflare Workers, D1, and R2. Those providers receive service requests under the operator's
configuration. They do not receive the host's conversation or file database through normal Team
transport.

Account session credentials are encrypted on the desktop with OS storage protection. The local
owner is a different identity, not a cloud session or paid license. Old account-bound files remain
on disk but are not adopted by local startup. Original marketplace publication, hosted-site,
commercial checkout, and license-management flows are disabled in this edition. Retaining their
backend code does not enable them in the local desktop or deploy a replacement cloud service.

## Hosted computers and charges

This desktop edition does not purchase or manage the original commercial hosted-server plans.
It does not open their checkout or send billing requests in the local flow. A user can run the
host on their own computer or server and separately configure remote access.

E2B is an optional third-party compute service, not a free replacement for E2B billing. The E2B
account associated with the supplied key pays for its use. Model providers and plugins may also
charge under their own terms. Removing OpenBot's billing UI does not change those terms or the
repository license.

## Central data retention

For an explicitly deployed account Worker, the retained maintenance task runs once each day.
This is service behavior, not a network task of the default local desktop. It removes:

- sign-in challenges after they expire or are consumed;
- account sessions after they are revoked (older already-expired sessions are also removed);
- team authentication tickets after they expire or are consumed;
- rate-limit records after their 15-minute window ends.

These technical records are normally removed within 24 hours after they become inactive. A failed
maintenance run can keep them until a later successful run. The task logs only aggregate deletion
counts. It does not log account IDs, email addresses, IP addresses, tokens, or ticket values.

Replacing or deleting an account avatar or host logo removes the previous R2 object on a best-effort
basis. Account/device sessions and logical remote sessions deliberately have no time-based expiration.
Logout or device revocation ends access; removing a team membership ends access to that team.
Revoking an account/device credential disconnects its active remote sessions, without disconnecting
other authorized devices. Older remote sessions without a device binding are disconnected account-wide
on revocation. Short-lived QR codes and connection tickets still expire.
Settings → Profile → Account sessions lets you list and disconnect other desktop or mobile sign-ins.
Only device/session labels, IDs, sign-in times and last-activity times are returned, never credentials.

## Mobile application scope

The following mobile behavior belongs to the retained optional app. Account services, push
credentials, mobile analytics, and native attachment limits have not been replaced by this
independent desktop change.

Mobile Settings can update your account name and photo through the same account API and list or
disconnect account sessions. The appearance preference is stored only on the phone.
After a profile change, the account API sends Signal a signed notification identifying the account.
Signal notifies only that account’s connected devices, without including the profile or credentials.
Devices check the profile and joined-server directory on a cold launch and every 15 minutes while active.
Returning from the background does not trigger an automatic check. On mobile, Notification Center and
other iOS `inactive` transitions do not count as leaving the app and do not reset the timer. Profile change notifications
can trigger an earlier refresh. These authenticated requests retrieve
account identity (name, email and avatar URL), not conversations or workspace content.

Mobile hidden and pinned chat preferences are stored on the phone, separately per account and server.
Conversation read/unread changes are stored on the desktop host and shared with your other connected devices.

The mobile app keeps a copy of what it shows for each server: the agent list, the hidden agents,
the sections, the server's capabilities, the latest page (up to 50 messages) of each chat that it
loaded, and the last values of the drawer (the member count, the usage cost, the next routine runs,
the thread and workflow counts, and the name and last run of each pinned workflow), up to 4 MB for
each server. It also keeps the last server list that the account service gave: for each server its
ID, name, logo version, public key and the time of its last key change, membership ID, role, member
limit, and hosted status. So after a start the app connects and shows them at once, while the
account service and the server answer. The copy is in the phone's system cache (`Library/Caches` on
iOS), which is not in a device backup and which the system can delete when the phone is low on
storage. Each file is encrypted with AES-256-GCM and bound to the account and the server, or to the
server list. The key is in the phone's keychain, and it does not leave this device. The copy is
never sent anywhere. The app replaces it with what the server and the account service send, and
deletes a server's copy when the account no longer has that server. Sign-out and an expired or
disconnected session delete all copies and the key. Attachments and files are not in the copy.

The mobile app keeps a support log of up to 1,000 events in the phone's system cache: app version,
system and device model, app state changes, connection steps with server IDs and error text, the
desktop app version and protocol support of each server, the method, address without query, status
and time of its requests, including Team API requests to the desktop, and app warnings and errors. It
does not record message text, files, request bodies or headers, and it masks tokens, keys and email
addresses. The app never sends the log. **Settings → Support** shows it and lets you save the file or
clear it.

Mobile chat, like desktop and web chat, shows the icon of the linked site beside a web link. To get
it, the phone requests `/favicon.ico` from the site of the link when it shows the message. The request
contains no conversation text. When the site has no icon, a local symbol shows. Mobile chat does not
fetch Markdown images when displaying a conversation.

Mobile chat can send selected files to the conversation's desktop host through the existing encrypted
team connection. Text pasted into the input is processed only after the user pastes it. A text paste
longer than 4,000 characters becomes a text attachment. Selected documents can also have a temporary
copy in the phone's system cache. Attachments added while editing a queued message are saved in the
phone's app document storage, with references in the saved edit, so they survive an app restart.
Those draft copies are removed when the attachment is removed or the edit is saved or cancelled.
A message that the phone has not delivered yet, for example while the server is offline, is saved
with its text, reply target and files in the phone's app document storage, separately per account,
so it survives an app restart. The phone sends it when the server is online again, and removes the
copy when the host confirms it, or when you edit or cancel it. Nothing else receives it. Sign-out
does not remove the copy: it is sent after you sign in to the same account again. A message to an
agent or server that you no longer have stays on the phone, because no chat shows it to cancel;
removing the app removes it.
Uploads are limited to 10 MB per file on mobile; successful uploads
become managed attachments on the host. Camera capture uses an in-chat preview. Photo selection uses the phone's system interface.
Image attachment previews are downloaded from the desktop host through the same encrypted connection.
Other attachments are downloaded when you choose Open or save. The phone creates a temporary file for
the system share sheet and removes it when that sheet closes. The app you select can keep its own copy.
Cloudflare account storage does not receive these files.
When you share text, a link, an image or a file from another app to OpenBot, the phone keeps a copy
of each file in its app cache until the chat that you choose has read it, or until you close the
share sheet. Nothing is sent until you send the message. On iPhone, the OpenBot share extension can
send the message itself, without the app. It uses the same encrypted connection to the host and the
same account service as the app. For this, the app gives the extension its session in a keychain
item that only the app and the extension can read, and writes the names of your servers and agents,
the agents' pictures and the servers' public keys to storage that only the app and its extensions share. These stay on
the phone, and sign-out removes them. The app tells iOS which agents you send messages to, so the
iOS share sheet can offer those agents first. iOS keeps this on the phone, and sign-out removes it. To find out whether a shared link points to
an image, the phone requests the link from its website and reads only the response headers. When the
link is an image, the phone downloads it and attaches it in place of the link. It stops a download
after 10 MB, and a larger image stays a link.

Mobile dictation and voice conversations listen only after you press the microphone. They use the
recognizer chosen under **Speech recognition** in **Settings → Voice**:

- Phone recognizer, the default. It is described below.
- Parakeet v3. When you press Download, the phone downloads the pinned Parakeet TDT 0.6B v3 model
  from `huggingface.co`, the same files as desktop, checks the SHA-256 of each file, and keeps it in
  the app's storage outside the device backup until you remove it. The request carries no user data.
  The audio and the recognized text stay on the phone.
- ElevenLabs Scribe, only with your own ElevenLabs API key. For each dictation, the phone asks
  `api.elevenlabs.io` for a single-use token with the key, then streams the microphone audio to
  ElevenLabs with that token, and receives the text. ElevenLabs handles the audio and the text under
  its own policy and your ElevenLabs plan. Nothing else is sent.

The phone recognizer asks for on-device recognition. On iOS, this applies when the phone supports it for your language. On
Android, it applies when the language model is installed. Otherwise, or when on-device recognition
fails before it recognizes any speech, the phone's recognition service, Apple or Google, receives the
audio. The recognized text goes into the message field and is sent
only when you send the message. OpenBot does not store or send the audio.

In a mobile voice conversation, the same recognizer hears what you say, and the recognized text is
sent to the agent as a message. The phone then reads the agent's reply aloud with the voice chosen in
**Settings → Voice**:

- Supertonic 3, the default. When you press Download, the phone downloads the pinned Supertonic 3
  model from `huggingface.co`, checks the SHA-256 of each file, and keeps it in the app's storage
  outside the device backup until you remove it. The request carries no user data. The reply text
  and its audio stay on the phone.
- ElevenLabs, only after you save your own ElevenLabs API key. The phone tests the key by listing
  your ElevenLabs voices and reading one character with the first voice, and then sends the text of each reply that it reads to `api.elevenlabs.io`
  with the key, and receives the audio. Nothing else is sent: no conversation history, file or agent
  instruction. ElevenLabs handles the text and the audio under its own policy and your ElevenLabs
  plan. The key is kept in the phone's keychain (iOS) or encrypted storage (Android), never in a log
  or an analytics event. Remove key in **Settings → Voice** deletes it.

The chosen voice settings are kept on the phone. OpenBot does not store the reply audio.

## Email delivery and infrastructure providers

The default local desktop sends no sign-in, welcome, billing, or license email and does not use
the upstream SMTP, Stripe, hosted-server, or status-page services. No card information is needed
to create a local owner.

A separately configured account service can send sign-in and invitation email through the
operator's SMTP provider. That provider receives the recipient address and message content,
including a one-time code or invitation link. Cloudflare can process account and configuration
requests when the operator deploys the retained Worker. Optional phone push and managed messaging
paths can use additional providers as described in their sections below. These providers can keep
their own security, delivery, and network logs under their own policies.

The independent account Worker can use Cloudflare Email Service for sign-in codes. It sends only
to the operator's configured email allowlist and preserves the requested recipient. Cloudflare
receives the sender, recipient and code email. The Worker does not expose development codes.
Its D1 database holds account, device, host and membership records; its private R2 bucket holds
account avatars and host logos. It has no billing or hosted-server purchase routes.

Legacy commercial backend code remains in the repository for compatibility and operator review;
it is not part of local desktop startup. Deploying that code requires its own configuration and
privacy review. It must not be treated as a self-hosted service that this change has already
provisioned or validated.

## Data stored on the OpenBot computer

Saved agent memories, their inclusion settings, and their full-text search index stay in the local
SQLite database. Essential memories enter the agent's provider instructions within a fixed size
limit. Other saved memories reach the provider only when the agent retrieves them with a memory
tool. Search runs locally and does not use an external search or embedding service. Memory content
is not included in analytics; provider output uses the application's secret redaction. After every
20 turns of an agent's chat or side thread, after 15 minutes with no new turn, when the user clears
the chat, and when the user closes a side thread, OpenBot sends the agent's profile, its essential
memories, the saved memories that relate most to the conversation, and the new part of the
conversation, with secrets redacted, to the agent's own provider, on the agent's model or on the
provider's lower-priced default model, which proposes memory changes. Nothing else receives them.
Server settings > General > Memory review sets the number of turns (10, 20 or 40) for the agents of
the server, or turns these reviews off; off, no review sends anything. An owner or admin of a joined
server can change it.

- `~/OpenBot/Agents` contains one workspace per agent. A profile written by a release before the
  bot-to-agent rename holds them under `~/OpenBot/Bots`; the application moves them on first launch.
  A local owner can select an existing project as an agent's working folder. OpenBot keeps the
  original managed folder and stores the binding in local agent metadata. It does not move or
  delete that project when the binding changes or the agent is removed. Groups keep member
  workspaces separate; workspace selection itself is not an operating-system sandbox.
- `~/OpenBot/Shared` contains managed transfers shared between agents, and
  `~/OpenBot/Shared/Data/agent-data.db` holds the records the agents keep for themselves between tasks.
  Every agent on this computer can read and write every table in that file, and the user can delete any
  table in agent settings.
- `~/OpenBot/Downloads` contains files downloaded by the embedded browser.
- `~/Library/Application Support/OpenBot` contains the OpenBot SQLite database, agent metadata,
  conversations, message queues, direct messages, reactions, read state, attachment drafts and
  indexes, team configuration, local team members and sessions, the browser profiles and their
  cookies, application preferences, and the provider CLIs OpenBot downloads. The downloaded CLIs are kept in
  one store for the whole computer, which no other profile data shares.
- The local team configuration contains team member profiles, password hashes and salts when local
  password sign-in is used, invite and session token hashes, and the team identity key pair.
- `~/.codex` is owned by Codex CLI and contains its login and thread data. OpenBot does not copy or
  manage Codex credentials.
- `~/.claude` is owned by Claude CLI and contains its login and session data. OpenBot does not copy
  or manage Claude credentials.
- MCP static headers and environment variables remain in local SQLite and are not encrypted by this
  change. MCP OAuth sign-ins are kept in `~/Library/Application Support/OpenBot`, encrypted by the operating
  system's secret storage in the same way as provider API keys. One record per server address holds
  the client registration and the access and refresh tokens. Removing the server in settings, or
  choosing Sign out on it, deletes its record. These values are redacted from logs, exports and diagnostics.
  The port and secret of the local MCP sign-in server are kept in
  `~/Library/Application Support/OpenBot/openbot-mcp-oauth-proxy-v1.json`, encrypted in the same way.
- The bundled GitHub MCP entry uses the user's PAT as an MCP header, with the storage limits above.
  The separate GitHub App connector is unavailable without an explicitly configured own client ID
  and app slug. Its encrypted store is scoped to that client ID; it does not load the upstream
  connector's old credential file. An explicitly enabled own installation-token broker is a
  separate configuration, never a default upstream request. The connector can create temporary
  mode-0600 credentials for `gh` and `git`; disconnect and normal shutdown remove them, while a crash
  can leave them until the next start.
- The original Link payment connection is disabled. Its earlier encrypted credential file is kept
  but is not loaded by the independent local flow.
- The ElevenLabs API key for dictation is kept in
  `~/Library/Application Support/OpenBot/voice-api-key.json`, encrypted by the operating system's
  secret storage. The app window never receives the key back. Remove key in **Settings → Voice**
  deletes the file. The key is redacted from logs, exports and diagnostics.
- The API key of the voice server is kept in
  `~/Library/Application Support/OpenBot/voice-server-key.json`, encrypted by the operating system's
  secret storage. The app window never receives the key back. Remove in the Voice server section of
  **Settings → Voice** deletes the file. The key is redacted from logs, exports and diagnostics.
- The Bitwarden connection keeps a CLI session key in process memory only. OpenBot does not
  save it to a file. Disconnect, eight hours without vault use, and app exit stop this connection.
  The log redactor can retain values in memory until exit to mask later messages.
  The Bitwarden CLI keeps its own encrypted vault cache. OpenBot reads login items in the folder
  `Shared with OpenBot`. Agents receive item ids, titles, and usernames; passwords and authenticator
  codes go through the main process to the browser page. This folder is an OpenBot access rule;
  the CLI session key can decrypt the wider vault. Use a separate Bitwarden account if you need
  the password manager itself to enforce that separation.
  An owner or admin of a joined server can connect that server's Bitwarden or Vaultwarden in
  Marketplace › Apps › Bitwarden with the server address, the personal API key and the master password. They
  go once, over the encrypted connection, to the server, which keeps them in
  `openbot-bitwarden-connector-v1.json` in its application data folder, encrypted by its operating
  system's secret storage, so it can unlock again after a restart. Its CLI keeps its own encrypted
  vault cache in `provider-state/bitwarden-host` in the same folder. The computer that sent them does
  not keep them, and no answer from the server carries them. Disconnect deletes the file and the
  cache. The API key and the master password can open the whole vault, not only the shared folder.
  They are redacted from logs, exports and diagnostics.
- The 1Password connection (Marketplace > 1Password) is kept in
  `~/Library/Application Support/OpenBot/openbot-onepassword-connector-v1.json`, encrypted by the
  operating system's secret storage. It holds the service account token and the account ID only.
  OpenBot keeps the list of logins (titles and web addresses) in memory, never on disk. A password
  or a one-time code is read from 1Password when the browser fills it, goes only to that page, and
  is never sent to an agent, a provider, a log or a team member. The token and each filled value
  are redacted from logs, exports and diagnostics. An owner or admin of a joined server can paste a
  service account token for that server in Marketplace › Apps › 1Password. The token goes once, over the
  encrypted connection, to the server, which keeps it in the same file on its own disk. The
  computer that sent it does not keep it, and no answer from the server carries it.
- The Vault (Server settings › Vault) is kept in
  `~/Library/Application Support/OpenBot/openbot-vault-v1.json`, encrypted by the operating system's
  secret storage. It holds the logins, payment cards (number, expiry, security code, name), contact
  info and API keys (variable name, key, notes) that the user saves. On a computer with no secret storage, such as Linux with no
  keyring, the Vault saves nothing. The file never leaves this computer. An owner or admin of a joined
  server can open that server's Vault in Server settings, from the desktop app or the web app: the
  list goes over the encrypted connection with no password, card number, security code or API key, and one of
  those goes to them only when they show or copy it. The iPhone app shows the same list and never
  asks for a password, a card number, a security code or an API key: a new one that the owner or admin types on
  the phone goes once to the server, and the phone does not keep it. Other team members cannot read it. An agent gets the login sites and usernames, the card names with their last
  four digits and expiry, and the contact info; it never gets a password, a card number, a security
  code or login notes. An agent can add and change contact info, change the username of a login (not
  its site) and the name, expiry and billing address of a card, and delete items, with no approval: the
  chat shows each change, and an item that an agent adds keeps the agent's name. Agents cannot see,
  add, change or delete a Vault API key as an item. When an agent lists its API keys, OpenBot writes
  each Vault key, readable only by the user, to
  `~/Library/Application Support/OpenBot/agent-api-keys/.vault/<NAME>`, outside every workspace, and
  gives the agent the path; every agent on the server can read these files in its commands. A changed
  key is written again, and a deleted key or a Vault that cannot be read removes its file, also at
  start. API keys are redacted from logs, exports and diagnostics. A password that the
  user types into the secure sign-in card goes to the Vault only while Save to Vault is checked. On a
  joined server, only an owner or admin can check it, the box starts unchecked, and the password goes
  to that server's Vault, not to the Vault of the computer where it was typed. The
  first card fill on a site waits for the server owner's approval; team members and messaging
  services cannot give it. The card then keeps that site and the origins of its card frames, and
  later fills there need no approval; the user can remove a site in the card. The
  browser types those values into the page, where the page's own scripts can read them, as they read
  what a person types. Until that page navigates, the agent cannot take a screenshot, evaluate
  script or record in that tab, and its snapshots hide the card fields. Passwords and card numbers
  are redacted from logs, exports and diagnostics, also in the desktop app of an admin who showed
  or copied one. A CSV import is read on this computer, from its own file dialog or from the text of
  a CSV export that an owner or admin picks in the iPhone app (`vault-import-v1`). That text goes once
  over the encrypted connection; the answer carries only the counts, and the phone deletes its copy
  of the file after it reads it.
- `~/Library/Application Support/OpenBot/logs/trace.ndjson` is a local trace of IPC calls,
  provider turns, main-process failures, and the steps of each connection to a joined server. Each
  line holds a time, the IPC channel name, the turn origin, the failure origin (`uncaughtException`
  or `unhandledRejection`) or the connection step (such as `remote-connect:ticket`), the duration,
  and the outcome word. A connection step does not name the server. The failure's error text goes only to the redacted log. The trace holds no payloads,
  messages, URLs, paths, or identifiers, and it goes through log redaction before it is written. It
  is kept to two files of 2 MB each and is never sent. It also records the exit of a renderer or
  helper process with its reason word, and the reason that OpenBot quit (such as
  `main_window_closed` or `quit`).
- `~/Library/Application Support/OpenBot/logs/main/main.log` holds the redacted lines of the main
  process: startup failures, uncaught errors, the reason that OpenBot quit, and why an update check,
  download or install failed. It is kept to two
  files of 1 MB each and is never sent.
- OpenBot keeps crash dumps of its own processes in the `Crashpad` folder of its user data
  (`%APPDATA%\OpenBot\Crashpad` on Windows). A dump holds part of the memory of the process that
  crashed, which can include conversation text, tokens or other secrets, and cannot be redacted.
  Dumps are never uploaded or added to a diagnostics export. Crashpad deletes old dumps by itself.
  Do not attach a dump to a public issue.
- `~/Library/Application Support/OpenBot/logs/resources.ndjson` holds one line a minute: the memory
  and CPU use of each OpenBot process group and provider id, the main process delay, the number of
  agent database statements, active turns and browser tabs. It holds no process IDs, program names,
  command lines or paths. It is kept to two files of 1 MB each and is never sent.
  `~/Library/Application Support/OpenBot/openbot-resource-summary-v1.json` holds the totals of
  today and of the previous day for the daily analytics summary and the diagnostics export.
- `~/Library/Application Support/OpenBot/openbot-push-notifications-v1.json` holds, for each member
  phone that gets notifications from this host, the session ID, the member ID, the Apple or Firebase
  push token, the secret that seals the notifications, the interface language, and the notification
  choices. Only the user can read the file, and it is not in the diagnostics export or the data
  export. See [iPhone notifications](#iphone-notifications) and
  [Android notifications](#android-notifications).
- `~/Library/Application Support/OpenBot/openbot-agent-notification-levels-v1.json` holds the
  notification level that the owner and each member of this host chose for the whole server and for
  each agent ("All activity", "Only when it needs me" or "Nothing"), by member ID and agent ID. Each member reads and
  sets only their own levels, and the host applies them to the desktop notifications of this computer
  and to the notifications that it sends to that member's phones. A removed member's levels are
  deleted. It is never sent to the OpenBot account service.
- `~/Library/Application Support/OpenBot/openbot-sidebar-pins-v1.json` holds the agents and channels
  that the owner and each member of this host pinned, in their order, by member ID, with agent and
  channel IDs only. Each member reads and sets only their own list, so their desktop app, web client
  and phones show the same pins. A removed member's list is deleted. It is never sent to the OpenBot
  account service.

Attachments copied into OpenBot remain in managed storage after their original file is moved or
deleted. By default, all agents share one embedded browser profile, including cookies and website
sessions. An agent can instead use a profile of its own, or a named profile that only the agents
assigned to it share. Profile names stay in the local database of the computer that runs the agents.
On a joined server, an owner or admin reads the names, colors and agents of the host's profiles through
the encrypted host connection, and each member reads the name and color of the profile of a browser tab
that they can see. Cookies and site data of a profile do not leave the host. Clear data and Delete
remove the cookies and site data of a profile.
Websites receive the browser's Chromium user agent. HTTPS sites and local loopback HTTP sites also
receive basic client hints with the Chromium major version, operating-system name, and desktop flag.
Google account requests retain the Electron version token for sign-in compatibility.

## Remote Team API

When the owner publishes OpenBot, the app starts an authenticated Team API on a localhost port. The
client and host use a separate OpenBot Signal service to establish WebRTC. Signal carries only
short-lived authentication, SDP, and ICE messages. Team API data uses WebRTC DataChannels. Remote
Desktop media and input use a separate WebRTC connection. A paste in the Remote Desktop viewer
sends the member's clipboard text to the host, which puts it on the host's clipboard. The live browser view sends compressed
images of the host's browser tab, and the watching member's pointer and key input, over that same
media connection. ICE uses a direct peer-to-peer path when possible. If a direct path is not possible, encrypted WebRTC traffic uses an OpenBot coturn relay.
An operator can instead configure Cloudflare Realtime TURN. Signal sends the operator's TURN key
to Cloudflare's credential endpoint and receives short-lived ICE credentials. Clients receive only
those short-lived credentials. Cloudflare relays encrypted WebRTC traffic and can observe network
addresses, timing and transfer volume. A named Cloudflare Tunnel can carry the Mac's Signal HTTP
and WebSocket connections. Tunnel terminates public HTTPS and forwards Signal traffic to a
loopback-only listener; chats and files still travel through the authenticated WebRTC connection.
When the owner selects **Private network** in Settings › Mobile Connect, the host gets no STUN or
TURN server, so no WebRTC traffic goes through an OpenBot relay. Team API connections then use only
addresses on a private network, such as the Wi-Fi or a Tailscale tailnet. The desktop media
connection gets the same empty server list for each new stream, so it also uses only a direct path,
which can be a public IPv6 address of the computer. Sign-in and Signal messages do not change.

Agents, conversations, queues, direct messages, attachments, browser data, prompts, approvals, and
Remote Desktop data remain on the host. The central account service does not copy them into D1 or
R2. The Signal service does not proxy them or write them to logs. The host does not need a public
inbound port. The things Signal passes to a host are the Slack events of an agent's Slack app, the
Discord mentions of the Discord app, the updates of the OpenBot Telegram bot, the GitHub events of
the repositories that its GitHub triggers watch, and the requests to webhook routines, in transit;
see [Workflows](#workflows), [Slack connections](#slack-connections),
[Discord connections](#discord-connections), [Telegram connections](#telegram-connections), and
[Webhook routines](#webhook-routines). For Discord and Telegram, Signal also carries the host's
answers to the platform.

An owner or admin of a joined server can manage its host from their own computer, or from the
browser client at `/app`. A provider API key, a custom endpoint key or header, the code that a
provider sign-in page shows, and a new server logo then travel from that computer or browser to the host over the same encrypted team connection. The
browser does not store a key. The host stores them as it stores a change made on the host.
No response returns a key, and neither computer writes request bodies to its logs. For a sign-in on
another device, the host sends the provider's sign-in link, and for Codex, Grok, Cline and Kimi its
one-time code, to that computer or browser, which shows them and opens the link only when the admin
asks. The provider's CLI on the host receives the login; no token travels to the admin.

## Other network connections

Network traffic can also occur when:

- the local Codex App Server connects to OpenAI;
- the local Claude Agent SDK connects to Anthropic through Claude CLI;
- a user or an agent visits a page in the embedded browser;
- a user submits text that is not a web address in the browser address bar, which sends the query to Google Search;
- a locally installed Codex plugin connects to its service;
- an MCP server the user enabled is reached at its own address, and, when that server asks for a
  sign-in, OpenBot connects to the server's authorization service to register itself, to exchange
  the grant the browser returns, and to renew the token. When the user signs out of the server or
  removes it, OpenBot sends the tokens it deleted to that same service once, to revoke them.
  Agents reach a server that OpenBot signed in to through a local server on `127.0.0.1`, which adds
  the token to each call, so the token does not go to the agent's process.
  That local server tells the MCP server that the client is OpenBot: it sends
  `User-Agent: OpenBot/<version>` and, when a session starts, the client name `openbot`, the
  OpenBot version and the title `<agent name> (OpenBot)`, so the server can show which agent made a
  change. Nothing else about the user's agents, conversations or files is sent in those requests. The
  registration does not name the upstream OpenBot logo or website;
- the user presses Install on the 1Password page. OpenBot downloads the 1Password CLI release that it
  pins from `cache.agilebits.com`, checks its SHA-256, and keeps it in
  `~/Library/Application Support/OpenBot/provider-state/1password-cli`. The request carries no user
  data;
- the user dictates or opens the Voice pane for the first time, or presses Download in **Settings →
  Voice**. OpenBot downloads the speech model that it pins, Parakeet, Underdog Bark 3.0 Plus or
  Whisper turbo, from `huggingface.co`, checks its size and SHA-256, and keeps it in `runtimes` in
  the application data folder. The request carries no user data. Dictation audio from these models
  stays on the computer, and the chosen model and language are saved in `voice-preference.json` in
  the same folder;
- the user selects ElevenLabs Scribe v2 Realtime in **Settings → Voice** and dictates or talks in
  the Voice pane. While the microphone records, or when a Voice pane turn ends, OpenBot streams the
  audio and the chosen language to `api.elevenlabs.io` with the user's own API key, and receives the
  text. Nothing else is sent: no conversation, file or agent instruction. ElevenLabs handles the
  audio and the text under its own policy and the user's ElevenLabs plan. The local models send
  nothing;
- the user sets up a voice server in **Settings → Voice**. OpenBot sends requests only to the address
  that the user enters, with the user's API key when there is one. To connect, it lists the server's
  models and voices. When the server does dictation, OpenBot sends the recorded audio, the chosen
  model and, when the user set one, the language to `/v1/audio/transcriptions` and receives the text. When the server reads
  replies aloud, OpenBot sends the text of each reply that it reads, the chosen model and the voice to
  `/v1/audio/speech` and receives the audio. Nothing else is sent: no conversation, file or agent
  instruction. The server handles the audio and the text under the policy of the person who runs it.
  The address and the choices are saved in `voice-server.json` in the application data folder;
- the user turns on Read replies aloud, opens the Voice pane for the first time, or presses Download
  in the Spoken replies section of **Settings → Voice**. OpenBot downloads the Supertonic 3 voice
  model that it pins from `huggingface.co`, checks its size and SHA-256, and keeps it in `runtimes`
  in the application data folder. The request carries no user data. The text of a reply that is read
  aloud, and its audio, stay on the computer. The setting and the chosen voice are saved in
  `speech-preference.json` in the same folder. In the Voice pane, the spoken reply runs on this
  computer, also for an agent on a remote server. Speech recognition uses the model chosen in
  **Settings → Voice**: a local model runs on this computer, and ElevenLabs gets the audio as
  described above. A message that the user speaks to an agent on this computer keeps its recording,
  a WebM/Opus file in the message's own transfer folder, so that the user can play it again in the
  chat. The agent, its provider and team members get only the text. A remote server gets only the
  text, as for a typed message, and no recording is kept. Recordings show in the Storage tab of
  **Server Settings**, where the user can delete them, and are part of a data export. A recording is
  deleted with the agent's or channel's data;
- the user connects Bitwarden. OpenBot runs the installed `bw` CLI to sync with the server already
  configured in that CLI, including a self-hosted server. It syncs before listing or filling logins.
  These calls send no OpenBot conversations, files, or agent instructions to Bitwarden. For a
  joined server's connection, the server's own `bw` signs in to the server address that the admin
  entered with the API key, and unlocks with the master password on that server. When that server has
  no `bw`, it downloads the Bitwarden CLI release that OpenBot pins from `github.com`, checks its
  SHA-256, and keeps it in `provider-state/bitwarden-cli` in its application data folder. That
  download carries no user data;
- the user connects 1Password. Connect runs the user's own 1Password CLI (`op`) on this computer to
  create the vault "Shared with OpenBot" and a service account that can read only it. OpenBot then
  reads that vault from 1Password's servers with the token: the vault names, the login titles and
  web addresses, and, when an agent signs in to a site, that login's username and password or code.
  Nothing about the user's agents, conversations or files is sent to 1Password;
- the user connects the bundled GitHub MCP entry with their own PAT, which reaches GitHub's official
  MCP endpoint. The separate own GitHub App connector, when configured, contacts GitHub for its
  device sign-in, token refresh, profile, and repository access. No credential goes to the original
  OpenBot token broker. An operator can explicitly enable their own broker; its configured service
  then receives the token needed for the requested installation-token operation;
- an operator requests a manual application release check from `OPENBOT_SELF_HOSTED_UPDATE_URL`,
  opens an explicitly configured `OPENBOT_RECOVERY_URL`, or runs a host installer/updater with
  `OPENBOT_RELEASE_REPOSITORY`. These have no original release-source fallback. The source receives
  the host's network address and artifact request, not chats or account credentials;
- OpenBot checks for new provider CLI releases when it starts, once an hour, and when you select
  `Check for updates`. It asks `api.github.com` for Codex and Kimi, `registry.npmjs.org` for Claude,
  OpenCode and Cline, `x.ai/cli` for Grok, and `raw.githubusercontent.com/agentclientprotocol/registry` and
  `dl.google.com` (for the download size) for Gemini, and the same registry and
  `downloads.cursor.com` (for the download size) for Cursor. Blocked versions come from a bundled
  list; fetching another list requires an explicit `OPENBOT_RUNTIME_BLOCKLIST_URL`. Native remote
  desktop artifacts also need valid local files, an explicitly pinned own artifact source, or a
  source build. These requests contain no account, agent, conversation or file data;
- an agent shows a visual reply, an agent checks its page with `html_preview`, or a user opens an
  HTML attachment, shared file or workspace file in the file preview. The page is HTML that the
  agent or the file wrote. It runs its scripts in a sandbox and can load scripts, styles, fonts
  and images from any address, such as a
  CDN. The server that holds those files gets the request and the network address of the computer,
  but no OpenBot cookies. The page cannot read the app, the conversation or other
  files. `html_preview` draws the page in a hidden window that has its own
  session in memory. The web client gets the page through the host connection and runs it in a
  sandboxed `srcdoc` frame with an opaque origin, so the page cannot read the web client's storage
  or its host keys; the browser sends no referrer for its requests. The mobile app runs the
  page in a web view, so the server gets the network address of the phone. On iPhone and iPad the
  web view keeps cookies and storage in memory only; on Android it has no page storage and no
  cookies for the files that the page loads. The page cannot call the app or read its files;
- a user opens an explicitly labeled external support or setup link;
- a Slack workspace is connected. See [Slack connections](#slack-connections);
- a Discord server is connected. See [Discord connections](#discord-connections);
- a Telegram chat is connected. See [Telegram connections](#telegram-connections).

## Webhook routines

Public webhook delivery requires your own configured account and Signal services. The default
local desktop does not connect to the original routing service. The following describes the
optional service path.

An administrator can give a routine a webhook trigger. The routine then gets a public URL and a
signing secret. The host stores the trigger and the encrypted secret in its local SQLite database.
The signing secret is encrypted with the operating system's secret storage. It is shown one time.
Management screens do not return saved secrets.

Requests to a webhook routine pass through OpenBot's Signal service to the connected host. Signal
uses the sender's IP address in memory for rate limits. The account service keeps only the route
metadata above. Neither cloud service stores or logs request bodies. The host verifies the request
signature before it accepts the event. If the host is offline, the sender receives an error and
must retry. There is no cloud event queue.

The host keeps a receipt of each request for 7 days, to ignore a repeated delivery. A receipt has
the delivery ID, the event type, the result, and the run ID, but not the request body. The event is
added to the run instruction, which the host stores with the run. Event data can reach the
routine's model provider, as other routine input does.

Change a routine to a schedule, or delete it, to stop its URL. Deleting a routine deletes its
receipts.

## Workflows

A workflow is a graph of steps that the user draws on a canvas. The host stores each workflow, its
graph, up to 50 earlier versions of the graph, its runs, and the input and output text of each step
in its local SQLite database. A run also keeps a copy of the graph and, for a webhook run, the
request body. Runs stay until the workflow is deleted. Nothing about a workflow goes to the account
service, except the webhook route metadata above.

Only an explicitly configured telemetry collector gets the kind of each workflow action (for example create,
run, approve or restore), the kind of the step, the result, the duration and a coarse failure code,
and the outcome, duration and step counts of each run. It never gets a workflow name, step text,
graph, or ID.

- **Agent steps** send their input to the agent as a routine message. The agent's model provider
  gets it, as with other routine input.
- **Model and condition steps** send their input to the provider and model that the step names,
  without tools.
- **Outputs to a messaging place** post the workflow name and the text through that messaging
  connection.
- **Notifications** show the workflow name and at most 200 characters of text, with secrets
  removed, only when notification previews are on.
- **Webhook triggers** work like webhook routines: the same route metadata, Signal path, encrypted
  signing secret, and 7-day receipts without the request body. The host refuses a body of more than
  64,000 characters. The body, marked as data, is the trigger's output and goes to the next steps.
  Remove the trigger, or delete the workflow, to stop its URL.
- **GitHub triggers**, when configured with your own GitHub App and routing services, receive events: issues, comments, pull requests,
  reviews and checks. GitHub sends each event to the configured Signal service.
  Signal checks GitHub's signature, reads only the installation and repository IDs, and passes the
  event to every computer that watches the repository, in transit only: it does not store or log it.
  When the Signal connection opens, the computer sends the account service its GitHub sign-in and the
  repositories that its GitHub triggers watch. The account service asks GitHub which of them that
  sign-in can see, signs a 5-minute route for those repositories, and stores neither the sign-in nor
  the list. The computer keeps the newest 50 deliveries of each trigger, without the event body: the
  delivery ID, event name, item number, time, and whether it started a run. An event that arrives
  while the computer is offline is lost; the history shows the gap.
- **Discord triggers** start a run from a mention of the OpenBot Discord app. The trigger's output, and
  the run that keeps it, has the message text, the author, and the name, type, size and Discord
  address of each file of the message and of the message that it replies to. These addresses expire
  after about a day.
- **GitHub outputs** make the change through the OpenBot GitHub App: a comment, a label, a person, a
  review, a close or a new issue. The text goes to GitHub. When a Discord mention started the run, a
  new issue or a comment also keeps those files: the computer downloads each file of up to 25 MB, and
  up to 50 MB for each change, from Discord and commits it to the `openbot-attachments` branch of the target repository,
  under `discord/<message ID>/`. The text links the files there. Everyone who can read the repository
  can read them, also after the issue or the comment is deleted; delete that branch to delete
  them. A file that the computer cannot copy is linked at its Discord address.

Members of a joined server can read, change, and run a workflow when they can see and use each
agent in it (`workflows-v1`). The graph and the step text then go to their computer. Only owners
and administrators see a webhook URL or make a new signing secret.

Deleting an agent keeps the workflows and their step history without the agent. Deleting a
workflow deletes its versions, runs, steps, and receipts.

## Slack connections

The upstream managed Slack connection is not available in the default local edition. This section
describes the retained optional path with an operator-owned app, account service, and Signal.
It is separate from configuring an independent MCP server.

A workspace member installs the OpenBot Slack app in their workspace from OpenBot on their computer.
The account service exchanges that install with Slack, because the app's secret lives there. It
records which OpenBot computer answers the workspace: the Slack workspace ID, the computer, the
OpenBot account that connected it, and the Slack app and bot user IDs. It keeps no Slack token and no
message. It gives the bot token to the computer encrypted to a key that only that computer has.

Slack sends the workspace's events, which contain the Slack messages in the channels OpenBot is in
and its direct messages, to the configured Signal service. Signal checks Slack's
signature and reads only the app ID and the workspace ID, to find the computer, and the type,
channel type, thread and bot ID of the event, to know whether it addresses OpenBot. It passes each
request to that computer over its Signal connection, in transit only: it does not store or log the
message. The answers go from the computer to the Slack Web API directly.

- **Stored on the host.** The bot token is encrypted by the operating system's secret storage, like
  provider API keys, and redacted from logs, exports and diagnostics. The database holds the
  workspace name and IDs, which agent is its Slack Orchestrator, and one row per Slack
  thread that an agent answers. The messages of that thread are kept as a conversation of that
  agent, with the Slack display name of each author, and files people send are kept with the agent's
  attachments. The database also holds the short facts about the workspace that its agents save
  (workspace memories); every conversation of that workspace shows them to the agent that answers.
  Disconnect revokes and removes the token and keeps the conversations and the workspace memories;
  deleting an agent removes its conversations and keeps the workspace memories.
- **Read from Slack.** The messages that mention OpenBot, the replies in a thread an agent answers,
  its direct messages, the files in them, the display names of their authors and of the people they
  mention, the names of the channels, earlier messages of a thread as context, and, when an agent
  asks for them, the newest messages of the channel or thread it answers in. OpenBot joins every public channel of the
  workspace, and Slack sends every message of each channel that OpenBot is in; the computer keeps
  only the messages that address OpenBot or continue a conversation.
- **Given to the Slack Orchestrator.** Every new Slack request goes first to the orchestrator agent,
  which runs on its provider like any other agent and passes the work to a teammate with the facts
  it needs.
- **Sent to Slack.** The agents' answers and the files they attach, short status posts ("Working on
  it…"), reactions, and approval requests with the command, folder and
  reason the provider gave, redacted. A failed request posts a fixed sentence, never the provider's
  error. Any agent, also in the user's own chat or a routine run, can post text, redacted, to a
  channel that OpenBot is a member of, and list those channels' names.

Anyone who can post in the Slack workspace, guests and Slack Connect members included, can give the
agents work. The agents run on the host with the access the user gave them. A hosted server that sleeps starts for a message that addresses OpenBot. Until it connects,
Signal keeps that message in memory for at most 10 minutes, encrypted to a key that only that server
has, so Signal cannot read it; a restart of Signal deletes it.

## Discord connections

The upstream managed Discord connection is not available in the default local edition. The
following path requires an operator-owned app and configured account/Signal services.

A member of a Discord server with the **Manage Server** permission installs the OpenBot Discord app in
that server from OpenBot on their computer. The account service exchanges that install with Discord,
because the app's secret lives there, and revokes the Discord sign-in token that it gets at once. It
records which OpenBot computer answers the Discord server: the Discord server ID, the computer and the
OpenBot account that connected it. It keeps no Discord token and no message.

Discord has one bot token for every server, so only the configured Signal service
holds it. Unlike Slack, both directions go through Signal:

- **To the computer.** Signal keeps the bot's connection to Discord. Discord sends it the messages of
  the channels OpenBot can view. When OpenBot's Signal has the Message Content intent, they include
  the text of every message; otherwise only the messages that mention OpenBot have text. Signal
  passes on only the messages that mention OpenBot or OpenBot's own role in the server, and the
  presses of OpenBot's buttons: the message
  text, the author's ID, name and role IDs in the server, the channel, the addresses of its files, and
  the message it replies to when a person wrote it (with its author, time, and the text and file
  addresses that Discord gave). The computer downloads the files from Discord directly.
- **From the computer.** The computer sends its posts, edits, reactions, files and name lookups to
  Signal, which makes each call to Discord for it, only in the Discord servers linked to that
  computer. To give context, the computer asks Signal for the earlier messages of a channel after the
  first message of a conversation, for the messages of the 15 minutes before a new conversation,
  and, when an agent asks for them, for the newest messages of the channel it answers in. These
  earlier messages have the addresses of their files, and the computer downloads those files from
  Discord directly. With the Message Content intent, these earlier messages have their text and files
  also when they do not mention OpenBot. It also asks for the names of the people that a message
  mentions, and, when the user chooses who can use OpenBot, for the names of the server's roles.

Signal does not store or log a message, a file or a token; it keeps the server and channel names and
IDs in memory to check each call. It answers a direct message to OpenBot with one fixed sentence and
passes nothing on.

- **Stored on the host.** The Discord server's name and ID, which agent is its Discord Orchestrator,
  the IDs and names of the roles allowed to use OpenBot in it, and one row per conversation that an agent answers, kept as a conversation of that agent with the
  Discord display name of each author. Files people send are kept with the agent's attachments.
  Workspace memories are kept as for Slack. Disconnect removes the link and keeps the conversations,
  the workspace memories and the allowed roles; deleting an agent removes its conversations. The
  author's role IDs are checked and not stored.
- **Given to the Discord Orchestrator.** As for Slack.
- **Sent to Discord.** As for Slack: the answers, attached files of at most 10 MB, status posts,
  reactions, and redacted approval requests. A post never pings anyone. As for Slack, any agent can
  post redacted text to a channel or thread of the server, and list their names through Signal.

Anyone who can post in a channel that OpenBot can view can give the agents work, unless the user
chose roles: then only members with one of those roles can, and OpenBot ignores the others. The agents run on the
host with the access the user gave them. A hosted server that sleeps starts for a message that addresses OpenBot. Until it connects,
Signal keeps that message in memory for at most 10 minutes, encrypted to a key that only that server
has, so Signal cannot read it; a restart of Signal deletes it.

## Telegram connections

The original shared Telegram bot is not used by the default local edition. The retained path below
requires a separately configured bot and operator-owned account/Signal services.

One OpenBot Telegram bot serves every user. Its token is only in OpenBot's Signal service
(the configured Signal endpoint); no computer has it. The user connects a chat from OpenBot on their computer:
the account service gives a one-use code, and the browser opens a `t.me` link with it. When the user
adds the bot to a group, or starts a direct chat with it, Telegram sends the code in that chat.
Signal then asks the account service to link the chat to the computer. The account service records
the Telegram chat ID, the bot ID, the computer, the OpenBot account and the time of the link, and a
hash of each code until it is used or expires. It keeps no chat name and no message.

Telegram sends each update of a linked chat, which contains every message of a group or a direct chat
and button presses, to Signal. Signal checks Telegram's secret
header and reads only the chat ID, a link code and the ID of a button press, to find the computer, and
the chat type, the entity types and whether a message replies or is in a thread, to know whether it
can address OpenBot. It
passes each update to that computer over its Signal connection, in transit only: it does not store or
log it. The computer's answers, status posts, reactions and files go to Telegram through Signal,
because only Signal has the token. Signal accepts only a fixed list of Bot API calls, only for the
chats linked to that computer, and returns only message IDs to it. Files go through Signal with
short-lived signed addresses, in transit only.

- **Stored on the host.** The bot ID, the bot username, the chat ID and the chat name are encrypted
  by the operating system's secret storage and redacted from logs, exports and diagnostics. The
  database holds the chat name and IDs, which agent is the Telegram Orchestrator, and one row per
  conversation that an agent answers. The messages of that conversation are kept as a conversation
  of that agent, with the Telegram name of each author, and files people send are kept with the
  agent's attachments. The names of authors and the last messages of a chat are also kept in memory
  for context, until OpenBot quits. Workspace memories are kept for each chat, as for Slack.
  Disconnect makes the bot leave the chat, unlinks it and keeps the conversations and the workspace
  memories; deleting an agent removes its conversations.
- **Read from Telegram.** Every message of a linked chat, the files in them, the names of their
  authors and the name of the chat. The OpenBot bot has privacy mode off, because with it on,
  Telegram does not send a plain mention to a bot that is not a group admin. A request starts only
  from a message that mentions the bot, a reply to it, another message of a reply chain that an
  agent answers, or a message of a direct chat. The other messages of a group stay in the
  computer's memory until OpenBot quits, and an agent can read the last of them with its history
  tool, as for Slack.
- **Given to the Telegram Orchestrator.** Every new Telegram request goes first to the orchestrator
  agent, which runs on its provider like any other agent and passes the work to a teammate with the
  facts it needs.
- **Sent to Telegram.** The agents' answers and the files they attach, short status posts ("Working on
  it…"), reactions, and approval requests with the command, folder and reason the provider gave,
  redacted. A failed request posts a fixed sentence, never the provider's error. As for Slack, any
  agent can post redacted text to a linked chat.

Anyone who can post in a linked chat can give the agents work. The agents run on the host with the
access the user gave them. A hosted server that sleeps starts for a message that addresses OpenBot. Until it connects,
Signal keeps that message in memory for at most 10 minutes, encrypted to a key that only that server
has, so Signal cannot read it; a restart of Signal deletes it.

The independent desktop reads bundled plugin listings locally. Public Registry browsing and
plugin connections have the separate network paths described above; they do not fetch catalog
pages from the original website.

Account usage shown in OpenBot is requested through the local Codex App Server. OpenBot does not send
that usage to its maintainer.

## Agent access

Agents currently use `danger-full-access` with `approvalPolicy: never`. They can read and modify local
files, run programs, use the network, and control the embedded browser without an OpenBot confirmation
dialog. This is an explicit product behavior, not a host security boundary. Keep backups and do not
give an agent a task you would not allow a local command-line tool to perform.

On first launch, OpenBot explains this access and does not start the agent services until you
explicitly accept it. The acceptance record stays in OpenBot's local application-support directory.

Computer Use is provided by `cua-driver`, a local binary that OpenBot ships and starts as its own
child process. It starts only when you open the Computer Use panel or an agent uses the function, and
it stops when OpenBot stops. Because OpenBot starts it directly, macOS attributes the Screen Recording
and Accessibility grants to OpenBot, and macOS keeps control of the prompts. Windows and Linux ask for
no such grant. Screen contents and accessibility trees that an agent reads through the driver go to
that agent's provider, the same as any other message content.

The driver is third-party software with its own product analytics, which its vendor turns on by
default and which are not OpenBot's. They would send the driver version, the operating system, a
random installation identifier, and a bucketed record of each tool call to that vendor. They never
send screen contents, window or application names, typed text, or the content of a tool result.

On its own the driver also asks GitHub for a newer release each time it starts.

**OpenBot stops both calls, always.** Every copy of the driver OpenBot starts gets
`CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_UPDATE_CHECK=0`, so it sends the vendor
nothing and asks GitHub nothing. OpenBot pins the driver version it packages, so a release check
could only offer you an update OpenBot would refuse. The driver reads the environment before its own
configuration, and OpenBot sets both variables last, so nothing can turn them back on for a driver
OpenBot started. OpenBot writes no file, so a driver you run yourself keeps the settings you gave
it.

Full access also permits that agent to publish, update and delete public hosted sites without
another confirmation. Publishing makes the selected site content publicly accessible. At Workspace
only or Ask first, hosted-site changes require confirmation. Site ownership and source validation still apply.

## Exports

The local data export writes a ZIP containing agent profiles, conversation snapshots, queues,
and managed message attachments. It intentionally excludes CLI credentials, browser cookies, and
agent workspace files.

The diagnostics export contains application and CLI versions, capability states, aggregate queue
counts, a summary of the local trace: counts, outcomes, and durations for each IPC channel,
turn origin, and failure origin, and the resource summary: the last sample and the memory, CPU,
responsiveness, database statement and crash figures of today and the previous day. It contains no conversations, visited URLs, account email, file
contents, or local file paths.

## Delete local data

Quit OpenBot, then remove the OpenBot folders listed above. Removing
`~/Library/Application Support/OpenBot` also removes the embedded browser's cookies and logins.
Removing `~/OpenBot` removes agent workspaces, transfers, downloads, and the records the agents kept. OpenBot does not delete
`~/.codex` or `~/.claude`; use each CLI's own controls if you also want to remove its local data.

Review folders before deleting them and keep a backup of anything you need.

## Questions

Direct privacy questions to the operator of this fork or its configured services. Use the
[fork repository](https://github.com/bin38/openbot) for source questions.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), without attaching
credentials, conversations, or unrelated private files.

When you ask OpenBot to generate or revise an agent profile, it sends your setup
prompt, the current profile draft (when present), and available sidebar section
names and identifiers to the selected AI provider through its local CLI. This
request does not include conversation history, saved memories, or workspace files.
The draft is reviewed before OpenBot saves it; generating a draft does not create
an OpenBot conversation or change an existing agent. The provider's own data and
CLI retention policies still apply.

When you change an agent's provider, the new provider receives the chat history with its first
message. That history includes the work steps that the previous provider recorded: commands, the end
of their output, changed file paths, tool names, searches and progress notes. OpenBot removes known
secrets from these steps first. Command output can contain file contents. Reasoning, diffs and
attachment contents are not sent.

Publishing an agent template in this edition saves its instructions, selected skills, routines,
and avatar to the host's local catalog. Secret-like text is rejected by the existing review path.
Workspace files and conversation memories are not included. The resulting `openbot://` shortcut
is not a public web page. Marketplace publication does not upload the user's account photo or a
package to the original account service. Explicit exports remain under the user's control.

### OpenCode

OpenBot downloads the OpenCode CLI (the `@opencode/cli` packages) and its license (from the
`opencode-ai` package) from `registry.npmjs.org`, then starts it with `opencode acp`. Prompts, attachments, and tool
results go to that local process. OpenCode can send them to the model provider selected in its
configuration. OpenCode's free models are the default, and they reach OpenCode Go with no account,
so a first OpenCode turn leaves this computer without a sign-in.

An OpenCode Go key is optional and unlocks the paid catalog. OpenBot encrypts it with the operating
system's secret storage, writes it to a file that only your user account can read, and passes it
to the local OpenCode process. To show the remaining Go quota in Usage, OpenBot also sends the key
to `opencode.ai/zen/go/v1/usage`; that request contains no conversation, file, or model data, and
the response contains only the used percentage and reset time of each Go limit. OpenBot does not
send that usage to its maintainer. No screen, log, data export, or diagnostics report contains the
key; the data export lists it under `scope.excludes`.

When you saved no key in OpenBot, OpenBot reads the Go quota with the key that the OpenCode CLI
uses: an OpenCode Console connection in OpenCode's database (`opencode.db`), else the Go key. The Go
key is the `opencode-go` key in OpenCode's `auth.json` (or `OPENCODE_AUTH_CONTENT`), or
`OPENCODE_API_KEY` from the environment that started OpenBot when `auth.json` has none. OpenBot reads
these from OpenCode's data folder (`$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`) and sends
the key only to `opencode.ai/zen/go/v1/usage`. When OpenCode rejects the Console key, OpenBot tries
the Go key. OpenBot does not store, log, or show these keys. OpenBot does not copy OpenCode credentials or upload its session
files. OpenCode manages its own login and resume state.

### Gemini

OpenBot downloads Google's Antigravity ACP server from `dl.google.com` when you select Download on
the Gemini row. Each provider update check also asks `dl.google.com` for the size of the newest
download, also when you do not use Gemini. Google's license does not let OpenBot include it in the application. OpenBot
starts the server as a local process. Prompts, attachments, and tool results go to that process,
and the server sends them to Google. Connect opens Google's sign-in page in your browser. On this
computer, Sign in saves a Gemini API key instead: OpenBot encrypts it in its existing provider
credential store, gives it to the server as `GEMINI_API_KEY`, and redacts it from logs. The server
sends the key to Google. The server keeps its login and session files in `~/.gemini`, or in `$GEMINI_HOME`. Each Gemini
account that you add after the first keeps them in a folder of its own in OpenBot's data folder, and gets no saved API key;
Remove deletes that folder. OpenBot does not read, copy, or upload these files. Google's terms apply: <https://antigravity.google/terms>.
Gemini agents stay on this computer: OpenBot does not show them to team members.

The local Gemini settings accept an unauthenticated HTTP/HTTPS proxy or SOCKS5. The address is
stored in `openbot-gemini-proxy-v1.json` in the app data folder. SOCKS5 username and password are
encrypted together with the existing operating-system secure storage; neither value is returned
to the renderer after saving. The page receives saved-state flags only. Credentials are not
accepted inside the address. An address change requires the credentials again or explicit removal.

For SOCKS5, main owns a loopback-only HTTP/CONNECT bridge. Its random local credential selects an
upstream configuration; only that local credential reaches Gemini or Colab process environments.
The bridge sends upstream authentication to the selected SOCKS5 server and streams the tunnel.
Existing turns can finish on their old configuration. New clients are blocked if bridge
preparation fails; there is no direct fallback. Shutdown closes connections and discards local
tokens. Known credentials are registered for diagnostic redaction. Instance transfer does not
include this proxy preference or its encrypted credential blob.

Gemini and the Colab CLI use this application proxy. Their local callback and harness connections
remain direct. Other chat providers, the system proxy, external browser authorization pages and
runtime downloads keep their existing routes. OpenBot does not disable Google's TLS validation.

To show the remaining Gemini quota in Usage, OpenBot sends the server's `/usage` command in a
session that no agent uses. The server asks Google for the quota of the signed-in account; the
command contains no conversation, file, or model data. The server keeps that session with its other
session files in `~/.gemini`. OpenBot does not send that usage to its maintainer.

### Google Colab CLI

OpenBot invokes the installed official `google-colab-cli` as local child processes. In-app sign-in
opens an allowlisted Google authorization page in the external browser. The one-time code enters
the CLI through stdin; it is not a chat message or process argument. The CLI keeps its own login
and session data under `~/.config/colab-cli`. OpenBot registers known OAuth and runtime tokens for
redaction and disables the CLI's debug logging when it invokes the Python entrypoint. The renderer
receives readiness and named-runtime metadata, not bearer tokens or runtime-token URLs.

Listing sessions and signing in do not allocate compute. Creating a CPU runtime, executing code
or notebooks, and uploading files send the requested content to Google and use the user's Colab
quota. The app does not purchase compute units or select a paid accelerator. Upload sources use
the calling assistant's existing workspace/Shared/allowed-folder checks. A local notebook runs
from a private staging copy; downloads return through managed attachments. Temporary staging is
removed after the command. Stopping a runtime can discard files that exist only on that VM.

This integration manages named CLI runtimes. It does not enumerate the user's Google Drive
notebook library or provide a VNC desktop. Google authorization, service availability and quota
remain separate from the local OpenBot account.

### Cursor

OpenBot downloads the Cursor CLI from `downloads.cursor.com` when you select Download on the Cursor
row. Each provider update check also asks `downloads.cursor.com` for the size of the newest
download, also when you do not use Cursor. OpenBot starts the CLI as a local process. Prompts,
attachments, and tool results go to that process, and the CLI sends them to Cursor. Sign in opens
Cursor's sign-in page in your browser, or the CLI uses `CURSOR_API_KEY` from the environment that
started OpenBot. OpenBot gives that key only to the local CLI, in its environment, and does
not store it. The CLI keeps its login and session files
in `~/.cursor` (on Linux, the login is in `~/.config/cursor`). On macOS the CLI keeps its login in
the login Keychain. OpenBot does not copy or upload these files. Cursor's terms apply:
<https://cursor.com/terms-of-service>. Team members see the host's Cursor agents, as for the other
providers, when their app supports Cursor.

To show the remaining Cursor plan usage in Usage, OpenBot reads the CLI's access token: on macOS
from the Keychain item `cursor-access-token`, else from the CLI's `auth.json`. OpenBot sends the
token only to Cursor (`api2.cursor.sh`, or `CURSOR_API_ENDPOINT` when you set it for the CLI), in
the same usage request that the CLI sends. The request contains no conversation, file, or model
data. OpenBot does not store, log, or send the token or the usage to its maintainer.

### Cline

OpenBot downloads the Cline CLI from `registry.npmjs.org`, and its license file from `github.com`,
when you select Download on the Cline row. OpenBot starts the CLI as a local process. Prompts,
attachments, and tool results go to that process, and the CLI sends them to Cline and to the model
provider you select in Cline. The provider of a free model can use your prompts to train models.
Sign in opens Cline's sign-in page in your browser, or the CLI uses `CLINE_API_KEY` from the
environment that started OpenBot. OpenBot gives that key only to the local CLI, in its environment,
and does not store it. The CLI keeps its login and session files in `~/.cline`, or in `$CLINE_DIR`.
OpenBot does not read, copy, or upload these files. When OpenBot reads the Cline model list, it
also sends `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` to read Cline's free
models, which the CLI does not list. The request has no account, key, or prompt in it, and Cline
sees the IP address of this computer. Cline's terms apply:
<https://cline.bot/tos>. Team members see the host's Cline agents, as
for the other providers, when their app supports Cline.

### Kimi

OpenBot downloads the Kimi Code CLI from `github.com` (GitHub release assets), and its license file
from `github.com`, when you select Download on the Kimi row. OpenBot starts the CLI as a local
process. Prompts, attachments, and tool results go to that process, and the CLI sends them to
Moonshot AI: `api.kimi.ai` for a global account, or `api.kimi.com` for a mainland China account.
Sign in runs `kimi login`, which opens Kimi's sign-in page in your browser: `auth.kimi.ai` for
Connect, or `auth.kimi.com` when you select the kimi.com (China) item in the row's ⋯ menu. The CLI
keeps its login, device ID, session files, and settings in `~/.kimi`, or in `$KIMI_SHARE_DIR`.
OpenBot reads only the API address in `config.toml` on this computer, to start the CLI with the
region of its login. OpenBot does not copy or upload these files. Unless you
set `telemetry = false` in `~/.kimi/config.toml`, or set `KIMI_DISABLE_TELEMETRY=1` in the
environment that starts OpenBot, the CLI sends anonymous usage events to
`telemetry-logs.kimi.com`. OpenBot does not change this setting. Moonshot AI's terms for Kimi Code
apply. Team members see the host's Kimi agents when their app supports Kimi.
### Hermes

OpenBot does not download Hermes Agent. It starts the `hermes` that you installed, with `hermes acp`,
as a local process. Prompts, attachments, and tool results go to that process, and Hermes sends them
to Nous Portal or to the model provider that you select in Hermes. Sign in runs
`hermes auth add nous`, which opens Nous Portal's sign-in page in your browser. Hermes keeps its
sign-ins, settings, memories, skills and session history in `~/.hermes`, or in `$HERMES_HOME`, and
it can change them during a turn. OpenBot does not read, copy, or upload these files. It reads only
the change time of `auth.json`, `.env` and `config.yaml` in that folder, or in the Hermes profile
that you use, to see that you signed in. Hermes can also use the network
for its own tools and plugins, as you set them up in Hermes. Nous Research's terms apply. Team
members see the host's Hermes agents, as for the other providers, when their app supports Hermes.

### Inception

Inception agents run in the Pi CLI that OpenBot downloads for Pi. On this computer, Sign in on the
Inception row saves an Inception API key. OpenBot encrypts it in its existing provider credential
store, gives it to the local Pi process in its environment, and redacts it from logs. Pi does not
write the key to a file. Prompts, attachments, and tool results go to that process, and Pi sends
them with the key to `api.inceptionlabs.ai`. When OpenBot reads the Mercury model list, Pi does not
contact Inception. Pi keeps its session files in its own folder, as for Pi agents. OpenBot does not
copy or upload these files. Inception's terms apply: <https://www.inceptionlabs.ai/docs/terms-of-use>.
Inception agents stay on this computer: OpenBot does not show them to team members.

### DeepSeek

DeepSeek agents run in the Pi CLI that OpenBot downloads for Pi. On this computer, Connect on the
DeepSeek row saves a DeepSeek API key. OpenBot encrypts it in its existing provider credential
store, gives it to the local Pi process in its environment, and redacts it from logs. Pi does not
write the key to a file. Prompts, attachments, and tool results go to that process, and Pi sends
them with this key to `api.deepseek.com`, also when Pi has its own DeepSeek key. When OpenBot reads
the DeepSeek model list, Pi reads its built-in list and does not contact DeepSeek. Pi keeps its
session files in its own folder, as for Pi agents. OpenBot does not copy or upload these files.
DeepSeek's terms apply:
<https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html>.
DeepSeek agents stay on this computer: OpenBot does not show them to team members.

### OpenRouter

OpenRouter agents run in the Pi CLI that OpenBot downloads for Pi. On this computer, Connect on the
OpenRouter row saves an OpenRouter API key. OpenBot encrypts it in its existing provider credential
store, gives it to the local Pi process in its environment, and redacts it from logs. Pi does not
write the key to a file. Prompts, attachments, and tool results go to that process, and Pi sends
them with this key to `openrouter.ai`, also when Pi has its own OpenRouter key. OpenRouter sends the
request to the company that serves the selected model, and that company's terms also apply. When
OpenBot reads the OpenRouter model list, Pi reads its built-in list and does not contact OpenRouter.
Pi keeps its session files in its own folder, as for Pi agents. OpenBot does not copy or upload these
files. OpenRouter's terms apply: <https://openrouter.ai/terms>. OpenRouter agents stay on this
computer: OpenBot does not show them to team members.

### Local model servers

When Server settings shows the Providers section of this computer, and once on the onboarding
provider step, OpenBot looks
for model servers on this computer. It sends `GET <address>/models` to
`http://127.0.0.1:11434/v1` (Ollama), `http://127.0.0.1:1234/v1` (LM Studio), and each address you
add under Local detection. These requests
contain no key, header, conversation or file data, and OpenBot does not follow a redirect. A found
server is only listed; OpenBot saves nothing until you select Add.

When you add or edit an endpoint, Load models sends the key and headers you typed to that address.
For a saved endpoint, OpenBot sends the stored key and headers only to the same origin as the saved
address. Local detection can be turned off in Settings. Its switch, addresses, folders and hidden
rows are in `openbot-provider-detection-v1.json` in the app profile.

### Custom agents

A custom agent is an ACP program that you name. OpenBot starts it as a local process, and prompts, attachments, and tool results go to that process. What the program sends
to the network is its own choice. Check agent starts it once in an empty temporary folder, sends
`initialize`, opens one session with no MCP servers to read the agent's models, and stops it.
To find agents, OpenBot looks up the names of known agents on your `PATH` and in the folders you
add under Local detection. It does not start a file that it finds.

The command, arguments, and environment names are in `custom-agents.json` in the app profile. The
environment values are encrypted with the operating system's secret storage, go only to that
process, and are not in a screen, log, data export, or diagnostics report; the data export lists
them under `scope.excludes`. Custom agents stay on this computer: OpenBot does not show them to
team members.

## Shared desktop channels

Channel names, purposes, participating agents, linked conversation references, messages, tasks,
assignment records, history summaries, and human read positions are stored in the host's SQLite
database. All authenticated members of that server can read and use its channels. Agent membership
selects participating agents; it is not a separate human access boundary.

The selected lead's provider receives relevant channel content for routing and history summaries in
separate sessions without work tools. Assigned agents receive the channel purpose, responsibilities,
request, relevant source messages, shared history summary, recent messages, and attachment references.
Agents can retrieve earlier channel messages and other conversations on that server when needed.
Unrelated conversations are not sent automatically. Provider session internals remain internal.
The provider's own data policies apply to content it receives.

Archiving a channel stops its work and retains its transcript. Restore makes the channel available again.
These actions do not remove agents, their memories, or linked conversations. Channel traffic between
desktop clients and a host uses the existing host transport. The account API and Signal service do
not store channel chats or make routing decisions. This feature adds no mobile chat interface.

## Mobile queue drafts

A phone stores the text and attachment references of an active queue edit in its secure local
storage, and keeps a copy of each file the edit adds in its own application storage, so it can
recover the edit after navigation or restart. These copies stay on the phone and are removed when
the edit is saved or cancelled. The host keeps the original message and a persistent edit hold
until the edit is saved, cancelled, or the message is deleted.

The desktop editor also keeps its active queue edit, attachment references, and edit identity in
local application storage. This lets it recover the held draft after restart. Neither client
releases the host hold merely because the editor closes or disconnects. The host also preserves
attachment drafts released by edit cancellation or message deletion until they are sent or
discarded. This lets a disconnected desktop recover its saved composer backup after host restart.

## iPhone Live Activity

The iPhone app can show the state of the agents on the Lock Screen and in the Dynamic Island. While
the app runs, the phone makes this view itself from the data that it receives over the encrypted
host connection.

When iOS stops the app in the background, the active host updates the view through Apple Push
Notification service (APNs). For this, the phone gives that host, over the encrypted host
connection, the push token of the Live Activity, a 32-byte secret for that host, its interface
language, and the file names of the agent pictures that it saved on the phone. The phone makes each
host secret from one random phone secret, so one host cannot seal an update or sign a button for
another host. The phone keeps its secret in its secure storage and makes a new one when the user
signs out. The host keeps these values in
memory only, for the session that gave them. It forgets them when the phone removes them, when the
session ends, when the member is removed or disabled, when Apple refuses the token, after 12 hours,
and when the host stops.

Each update contains the text that the view shows: agent names, the current task, the first
sentences of the last reply, a question and its options, or a command that waits for approval. The
host and the phone hide secrets and email addresses in this text, as in notifications. The host seals the update with
keys made from the secret (an HMAC-SHA256 keystream and an HMAC-SHA256 tag) and sends it to the
OpenBot account service, which sends it to Apple. The account service and Apple receive only the
push token, the sealed bytes, the time, the priority, the time when the content becomes out of
date, and, for an update that shows an event that would notify the member, the sound name. They
cannot read the content. The widget on the phone opens it and shows nothing with a
wrong tag. The account service stores nothing from these requests and does not log them. It makes
the Apple request itself. An update with a sound lights up the screen and has "OpenBot" as its
only text, so a host cannot use it to send an ordinary notification. Apple can keep its own delivery logs under its own policy.

The buttons in the view open the app. A button that changes host state, such as Approve or an
answer, has a signature made with a key that only the phone and the host have, so another app
cannot start the action with an `openbot://` link. The app shows the command again before it
approves it.

Settings > Notifications > Live Activities turns this off. The phone then removes its token from the
host.

## iPhone notifications

The iPhone app can show a notification when an agent finishes a task, stops with an error, or needs
an answer, an approval, or a step in the browser, while the app is not on screen. The host does not
send one while the member uses a desktop app. For this, it keeps in memory the time of the last
send, answer or typing of each session, and on its own computer it reads whether the OpenBot window
has focus and how long the computer has had no input. While the phone shows the Live Activity of
that host and the activity shows the event, the host sends no notification. With Play sound on, the
Live Activity update lights up the screen and plays the sound instead. An event that comes while
the app looks on screen stays in the memory of the host for at most 5 minutes, in case iOS suspended
the app before it said that it went away, and then goes as a notification if you did not see it. For this, the phone gives each connected host, over the
encrypted host connection, the Apple push token of the app (none when notifications are off and only
the Live Activity plays the sound), the 32-byte secret for
that host (the one of the Live Activity), its interface language, and the choices of the user: the
events of that server, a mute end, whether the notification shows a preview, and the sound, or none,
and when its Live Activity of that host started. The host
keeps these values in a file that only the user of that computer can read, so it can notify the phone
after a restart. It removes them when the phone removes them, when the member is removed or
disabled, and when the account service or Apple refuses the phone.

Each notification contains the agent name and a short text. With previews on, the text is the first
sentences of the agent reply, the question, or the command or reason of an approval, at most 200
characters, with secrets and email addresses hidden as in desktop notifications. With previews off, it only says what
happened, such as "Finished working.". The host seals the notification with keys made from the
secret, as it seals a Live Activity update, and sends it to the OpenBot account service with the
account session of the phone. The account service sends nothing when that session has ended, when
the device signed out, or when the membership was removed. Otherwise it sends the notification to
Apple with "OpenBot" as its only text. The account service receives only the push token, the session
ID, the sealed bytes, the sound name, and the time. Apple receives the same values without the
session ID. They cannot read the agent name or the text. The account service stores nothing from these requests and does not log them. Apple can
keep its own delivery logs under its own policy.

On the phone, the notification extension of the app opens the notification with keys that the app
keeps in its App Group, and iOS shows the agent name and the text. A notification that the extension
cannot open shows the app name only, so the account service, Apple, or a host that does not have the
keys of the phone cannot make it show text. A host that has the keys can show text only in the name
of its own server. Signing out removes the keys from the phone, asks each connected host to remove
the registration, and makes a new phone secret. A host that does not get the request sends nothing
more, because the account service refuses the ended session.

Notifications only inform: they have no buttons, also on a paired Apple Watch. The app keeps its
sign-in, the keys of the hosts and the server list choices in the iOS keychain with access after the
first unlock since the phone started, on this device only.

Settings > Notifications turns this off, and sets the preview and the sound. The events and the mute
of each server are in the same place and in the server settings.

## Android notifications

The Android app shows a notification for the same events, and in the same conditions, as the iPhone
app. Android has no Live Activity. For this, the phone gives each connected host, over the encrypted
host connection, the Firebase Cloud Messaging push token of the app, the 32-byte secret for that
host, its interface language, and the choices of the user: the events of that server, a mute end,
whether the notification shows a preview, and the sound, or none. To get the token, the Firebase
library in the app connects to Google. The app has no Firebase analytics. The host keeps and removes
these values as it does for an iPhone, in the same file, and removes them also when Google refuses
the phone.

The host seals each notification as it seals an iPhone notification, and sends it to the OpenBot
account service with the account session of the phone. The account service checks the session as it
does for an iPhone. Then it sends Google a data message that has only the sealed bytes and the sound
name. The account service receives only the push token, the session ID, the sealed bytes, the sound
name, and the time. Google receives the push token, the sealed bytes, and the sound name. They cannot
read the agent name or the text. The account service stores nothing from these requests and does not
log them. To send, it uses a Firebase service account key, which it keeps as an encrypted secret.
Google can keep its own delivery logs under its own policy.

On the phone, the app opens the notification with keys that it keeps in its private files folder,
and Android shows the agent name and the text. A notification that the app cannot open shows the app
name only. Signing out removes the keys from the phone and makes a new phone secret, as on an iPhone.
Notifications only inform: they have no buttons.

Settings > Notifications turns this off, and sets the preview and the sound. Android also lists one
notification channel for each sound in the system settings of the app.

## Optional macOS Host Manager

An administrator can install a local Host Manager for several native macOS users. It reads only
registered UIDs, process IDs, application versions, restart readiness, timestamps, and health
booleans through separate local status directories. It does not read or back up tenant homes,
workspaces, databases, provider directories, browser data, or conversations. It requests release
metadata and application downloads only after the operator sets their own
`OPENBOT_RELEASE_REPOSITORY`; those requests expose the host's network address to GitHub. There is
no default repository. The manager also requires the signing team ID for the operator's build and
checks the staged source before replacement. It sends no tenant status or tenant content to GitHub.

The separate, optional administrator account-setup command creates new local Standard users and
empty private homes. It saves generated login passwords in a root-only file under
`/private/var/root` for the administrator to retrieve. It does not transmit those credentials or
include them in logs. The installed administrator CLI shows each password once on the controlling terminal after setup,
then removes the recovery file. A failed setup retains that root-only file for administrator recovery.
The administrator controls secure password delivery. Host verification reads home metadata only
and tests cross-user access using harmless temporary files outside tenant homes.

### Remote desktop setup diagnostics

When an authenticated server member checks remote desktop setup, the host sends its computer name,
macOS account name, permission and service results, active session count, and check time to that member.
A live test also sends a temporary four-digit code and mouse and keyboard test results. These results
stay in memory and are not sent to analytics. Screen video uses the existing remote desktop connection.
Permission approval remains in macOS System Settings on the host.

## Secure browser authentication

Passwords, email/SMS codes, and authenticator codes entered in a secure chat card are sent to the
shown HTTPS site for one submission. Connected desktop, mobile and browser clients send the value through
the authenticated Team API to the computer running the browser. The handoff does not add the value
to chat, provider tool arguments, diagnostics, analytics, or a credential store. Input and submission
values are held in memory for the operation; cancellation and submission clear the input.

OpenBot blocks agent browser access while consent is pending. Before entering a submitted value, it
blocks image capture and live browser streams, and stops
and discards the active browser recording before entry. After entry, protection stays until the
browser replaces the document. After a same-page submission, OpenBot clears the filled fields and,
when the value no longer appears in the page title, address, text, field values, or attributes, keeps
the page, so a later login step on the same page stays available. Page code can still hold the
value, so page evaluation and recording stay blocked in that tab and its connected popup or opener
tabs until the page navigates. Otherwise OpenBot loads the current URL as a new
document with a GET request instead. Failed submission or reload requires manual takeover. Recording does not restart
automatically, and the tab's back/forward history is cleared after replacement to prevent restoring
the sensitive document. The destination site receives the value and controls its own processing.
This protection does not isolate credentials from the operating system or agents with unrestricted
machine access. Values pasted into ordinary chat are not covered by secure handoff.

## Error and warning reports

The independent desktop and browser client send no reports to the original collector. Without an
explicit collector, their remote report path is disabled. Local logs and diagnostics remain on
the host; exporting them does not automatically send them to a maintainer.

When an operator configures a collector, reports can contain version, platform, provider/model,
operation, severity, a bounded cause code, and a random report ID. They exclude displayed message
text, raw exceptions, stack traces, prompts, files, paths, commands, and credentials. Enabled report
queues are bounded to 1,000 reports, 1 MiB, and seven days. A failed send can be retried. Removing a
collector stops new delivery but does not remove data that its operator has already received.
The mobile app retains its separate reporting configuration and requires separate review.

### Remote host release checks

A manual host release check needs `OPENBOT_SELF_HOSTED_UPDATE_URL`. The configured source receives
an operating-system/architecture manifest request and the host IP address, with no account data,
chats, files, commands, or credentials. There is no original GitHub release feed by default.
Connected administrators can receive installed/release versions, check status, and installation
method. Host installation tools separately require the operator's release repository and preserve
manifest hashes and platform signature checks.

## Pi, Muse, and ACP registry setup

Pi and Muse run on the host selected for the agent. They receive the conversation input, attached
images, tool definitions, and enabled MCP server configuration needed for a turn. Provider account
files remain under each provider's control. An explicit Meta API key is encrypted in OpenBot's
existing provider credential store. Log in with code for Muse starts a local Muse process, with no
shell, no file writes and no Meta API key, that asks Meta for a code. You confirm the code on Meta's
page, and Muse keeps the account in its own files. Settings responses and settings-change events contain no
provider credentials; the event carries only the agent ID.

ACP registry search fetches the catalog from `cdn.agentclientprotocol.com`; search text is matched
on the host. Installation downloads the selected distribution from its published source. Pi update
checks use `api.github.com`. Muse update checks use `api.meta.ai`, and manifests and binaries come
from `lookaside.facebook.com`. Download requests reveal the host IP address and requested artifact.
Registry install records remain on the host, separate from conversations and credentials.

An authorized remote administrator can install, update, cancel, or remove a registry runtime on
the host through the encrypted Team connection. Removal does not delete agent configuration,
credentials, or conversations. The existing cloud service does not store those files.
