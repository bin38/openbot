# Local workspaces and Google integrations

These controls belong to the computer that runs OpenBot. They add local IPC groups, not released
Team API fields or remote account-service storage.

## Assistant working folders

`agent-workspaces.ts` validates canonical existing directories. It rejects reserved OpenBot roots,
nested overlaps with another assistant and non-directory paths. Several assistants can explicitly
select the same external project. Managed folders remain private. `AgentStore` keeps the selected `workspacePath`
and an internal `workspaceBinding.originalPath` for the managed folder. The binding is omitted
from public agent summaries. Existing records without a binding keep their managed behavior;
there is no SQL schema migration.

`AgentService.setAgentWorkspace` serializes the transition and rechecks that the assistant has no
running turn or unfinished delivery before commit. It unloads private provider thread state and
emits the updated agent list. The public agent and conversation IDs remain intact. Switching does
not move files. Restoring returns to the original managed folder. A missing custom project is
reported instead of silently recreated. Removal deletes managed data, not the selected project.
Duplication copies the original managed workspace into a new managed folder; it does not reuse
the original assistant's custom project binding.

`agent-workspaces-handlers.ts` exposes the native directory picker and folder-opening actions to
trusted local renderers. The profile panel displays current/managed/shared locations. Channel
creation and editing reuse the existing member selector and show that members retain their own
working folders. Shared is the existing host-wide delivery location, not a physical merge of the
member directories. Workspace selection is not a new OS sandbox; the existing access mode still
defines the provider's file permissions.

`ProjectWorkspaces` stores remembered canonical paths and names in the local
`openbot-project-workspaces-v1.json`. Native folder selection supplies new paths; renderer requests
use saved project IDs. Invalid or newer saved records stay read-only. Forgetting a choice removes
only its list entry. The local creation endpoint binds the project before preparation and the first
message; failure cleanup removes only the assistant's managed data.

`project-context.ts` reads fixed Git metadata commands without a shell, optional index locks,
fsmonitor, remote access or status filters. Output and execution time are bounded. It discovers
instruction and `SKILL.md` locations from the working directory up to the Git root using filesystem
metadata only. It does not read those instruction bodies or claim that every detected file is loaded
by the provider. Plain folders also work; unavailable Git and missing folders have separate states.
Codex retains native instruction and `.agents/skills` discovery. Ancestor skills are shown in the
overview; existing skill previews and tags retain their workspace-containment rules.

Automatic bundled-skill synchronization targets managed workspaces only. External-project prompts
keep assistant persona and private bookkeeping separate from project instructions, and preserve
other assistants' changes. Changing the project refreshes skill suggestions; selecting the current
project again does not reset provider context. No Git worktree is created automatically.

## Colab CLI

`colab-cli.ts` locates the installed `google-colab-cli` entrypoint and invokes it with bounded
output, deadlines and owned-process cleanup. Its Python entrypoint disables debug logging. Main
validates the Google authorization URL and opens it through the normal external-link adapter.
The code is submitted through stdin; cancellation stops only that login process and preserves
saved CLI credentials.

Before and after CLI operations, OpenBot makes the current user's official Colab token and session
cache files private. Unsafe linked or foreign-owned cache paths stop the operation. File contents
and saved login identities stay unchanged.

`ColabService` owns named-runtime metadata, login state, child processes and private staging.
Its status DTO contains no OAuth code, bearer, runtime proxy token or authenticated runtime URL.
Session listing and login allocate no runtime. New runtime requests are CPU-only; the service
does not buy compute units. Existing named runtimes can be opened, queried, used for Python or
stopped explicitly. This is not an API for listing Drive notebook documents or serving VNC.

`agent/colab-tools.ts` validates nine tools. Upload and local-notebook sources are opened through
the calling assistant's attachment gateway with `allowAnyReadablePath: false`. A notebook runs
from a staging copy. Downloads use managed attachment sources and clean up after consumption.
Model-facing text is shortened separately from the managed file path. Execution and transfer
still use the Google account's permissions and quota.

## Application proxy ownership

`GeminiProxySettingsStore` reads the old HTTP preference format and adds an encrypted credential
envelope for SOCKS5. Username and password are encrypted together, including when their values
are equal. Summary responses contain saved-state flags only. Blank fields retain credentials for
the same address; a changed upstream identity needs reentry or explicit clearing.

`GeminiProxyBridge` owns one authenticated loopback HTTP listener. Random local tokens select
immutable SOCKS configurations. The native SOCKS adapter validates fragmented RFC 1928/1929
handshakes and forwards domain resolution to the proxy. HTTP and CONNECT bodies stream with
backpressure. A preparation failure blocks fresh runtime settings; an old active turn can finish
with its original token. A bounded snapshot set refuses another change rather than evicting a
configuration still held by a provider. Shutdown destroys connections and awaits owned requests.

Gemini and Colab receive the effective HTTP route through getters at process creation. Upstream
authentication stays in main. Other chat providers and `process.env` are not changed. External
browser authorization pages and provider downloads keep their existing routes. Google TLS
validation is not disabled. The teardown registry closes Colab/provider processes before the proxy.

## Focused verification

- `scripts/agent-workspaces-e2e.ts`: existing project sentinels, busy/overlap rejection, restart,
  duplicate independence, channel membership, old links and non-destructive restore/removal.
- `scripts/colab-service-e2e.ts`: isolated CLI login, explicit CPU allocation, execution, managed
  files, notebook copies, cancellation and known-token redaction.
- `scripts/gemini-socks5-e2e.ts`: real loopback HTTP/CONNECT and SOCKS services, authentication,
  remote DNS, IPv6, streaming, changed configuration, failure, cancellation and shutdown.

Fixture success does not establish a real account's OAuth grant, available quota or allocation
availability. Those need separate live checks after user authorization.
