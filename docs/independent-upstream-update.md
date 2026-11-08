# Independent upstream integration audit

The reviewed snapshot is `nightly-labs/openbot` main
[`ca602c938ea0b853ecf62019e72a4fb4efb226ad`](https://github.com/nightly-labs/openbot/commit/ca602c938ea0b853ecf62019e72a4fb4efb226ad),
dated 2026-11-08. The initial comparison found 459 upstream commits beyond the independent
baseline. This batch backports the compatible changes below; it is not a wholesale merge of those
459 commits or a claim that later upstream commits were reviewed.

The independent account origin, local owner, disabled upstream commerce/telemetry/update feeds,
E2B controls, streaming uploads, custom API channels, Gemini account catalogs and proxy remain
independent behavior. The original license and attribution remain intact.

## Selected changes

| Upstream source | Integrated behavior and boundary |
| --- | --- |
| `604d69c8ab` | Desktop joined-server reconnect treats captive-portal/non-JSON failures as transport failures and uses shorter backoff after a recently online connection. This does not change the independent phone Signal launcher. |
| `118d5d182b` | Routine wake recovery handles a suspend whose resume event never arrives; disposal removes the timer. |
| `f37a28586b` | A routine can list routines while the wrapper still forbids routine creation, changes, deletion and test runs. |
| `de95ec975e` | More genuine next-step phrases can continue a turn; continuation count and explicit approval/deploy waiting cases remain bounded. |
| `9ae5d1847e` | Provider sign-in failures show a bounded, redacted reason when one is available. |
| Runtime part of `3c4e8ef45c` | Codex's informational “Under-development features enabled” notice no longer becomes a false error. |
| `2bfce4ac53` | Model browser screenshots use CSS-pixel dimensions for matching clicks; human previews retain resolution. Large browser/GitHub text has bounded model output and read-more guidance. Upload/download limits and the 64 KB evaluation safety cap are unchanged. |
| Lossless parts of `ee170a3c30` | Profile, section and side-question JSON omit indentation while preserving values and tag escaping. Tool inventory and dispatch validation remain intact. |
| `a83d29042a` | Equal settings writes do not repeatedly rebuild selection menus and lock the window. |
| `b79bcda061` | Duplicating an assistant retains an explicitly named browser profile; a private browser session stays separate. |
| Adapted `bd2558dde7` | Human browser tabs remain available after their first page fails to load. Failed agent/private-login tabs still clean up. Certificate validation remains active. |
| `54a8997d9b` | The narrow-sidebar wait indicator uses the intended round badge. |
| `180e947de8` | New MCP routing headers pass through the local sign-in proxy for compatible signed-in remote MCP servers. |
| Adapted `57835fdcb7` | Queue **Send now** captures the server and active turn, reorders only eligible messages, and interrupts only after a valid reorder. Edits, disposal, server switches and a newer turn prevent stale interruption. |

## Independent additions

Each assistant can select an existing local working folder and restore its managed folder without
moving project files or changing its public conversation identity. Group channels combine existing
members while keeping their workspaces separate. Busy assistants and overlapping/reserved folders
are rejected. A selected project is kept when the assistant is removed.

The Google integration adds in-app login for the installed Colab CLI, named runtime controls and
nine validated assistant tools for status, sessions, explicit CPU creation/stop, Python, files and
local notebooks. It does not present Drive documents as a notebook library or claim to provide an
E2B-style desktop. See [local integration ownership](architecture/local-integrations.md).

Authenticated SOCKS5 is handled by a private in-app HTTP bridge. Both upstream credential fields
are encrypted together and are write-only at the renderer boundary. Gemini and Colab can use the
effective application route without changing TUN, system proxy settings or Clash node definitions.
The external browser authorization page remains outside this process proxy.

## Version decisions

| Component | Confirmed decision |
| --- | --- |
| Installed `google-colab-cli` | Updated from `0.7.4` to `0.7.5`, with its previous environment retained as a rollback copy. |
| Google Antigravity ACP | Installed `1.4.5` matches the official registry snapshot checked for this batch. No replacement is needed merely because OpenBot upstream has a new app version. |
| `@agentclientprotocol/sdk` | Keep `1.9.0`, which matches the reviewed upstream. npm `2.4.0` is a major change with different peer requirements; its migration is deferred instead of mixed into this batch. |

Independent app versions are not Team API versions and do not track upstream app SemVer. No
released Team API codec or database schema migration was added for these local integrations.

## Context and validation budget

The nine Colab tools add measured context: descriptions `+1365` bytes, schemas `+1519` bytes and
the visible-tool catalog `+255` bytes. This is an explicit feature cost. The lossless instruction
compaction reduces the measured instruction text by 17 bytes. No tool was removed and no custom
API, E2B or Colab dispatch validator was reduced to meet a context budget.

## Deferred dependency sets

| Source | Why it is not imported wholesale |
| --- | --- |
| `7c3a9f4f6c` and the turn-context/background-model clusters | Broad provider lifecycle, idle-thread and resource changes need their earlier context modules. Replacing the local runtime wholesale would risk Gemini proxy/account behavior. |
| Remaining `ee170a3c30` schema/prose reductions | Advertised schema thinning and removed guidance need their own malformed-input/tool-discovery review. Full dispatch schemas remain in use. |
| `01bdb55cc1` | Google verification links require an earlier ACP failure-cause/empty-output chain and local link-event UI. The single commit is not a complete migration. |
| `a487f743bd` | Workflow-to-channel output is useful but the full patch assumes Telegram/Slack workflow and related UI features absent in this baseline. It needs a separate coherent adaptation. |
| `ab834deab8` | Channel progress depends on narration rows, response-style and provisional-answer machinery absent here. |
| `6a5dfbe9b9`, `457eeda5c3`, `ca602c938e` | These particular local-script, color and startup-animation fixes depend on missing upstream features or different authentication/animation ownership. Their surrounding modules are not replaced. |

## Evidence and limits

The focused workspace, Colab, authenticated SOCKS and queue E2E scripts write reports under
`.openbot-build/{agent-workspaces-e2e,colab-service-e2e,gemini-socks5-e2e,queue-send-now-e2e}/`.
The inspected reports mark these isolated cases passed. They use fixtures, not live Claude
inference or a real Google compute allocation. Node and renderer types were checked separately.

The MCP OAuth fixture passed 20 cases. The real isolated browser result-size check covered Retina
scale 2, CSS/image dimensions of 1200 × 800, larger/scale-3/mobile click cases and shortened GitHub
model text from 85,779 to 40,257 characters. Full suites and cross-platform/live phone validation
remain CI or manual checks. Live Google authorization, real proxy availability and account quota
must be recorded separately; fixture success does not establish them.

The local Chinese development app detected Colab CLI `0.7.5` and displayed its saved credentials.
A read-only runtime refresh required a fresh Google sign-in. No runtime was allocated and no
notebook was executed. The assistant settings displayed the current working folder, folder picker
and Shared-folder action. The final Colab fixture passed ten cases, including concurrent login,
early stdin closure and preservation of exact external session names.
