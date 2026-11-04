# Independent development startup

`bun run dev` starts only Electron and its Vite renderer. It checks the pinned Bun version and
installs changed dependencies, but does not start an Account API or Signal process, apply D1
migrations, copy service keys, generate account-service identity, or seed a cloud account.
The application creates its local owner itself and can use the existing local Codex sign-in.

The worktree hash, `OpenBot Dev wt-…` profile, renderer output directory, and instance registry stay
the same. Starting the independent app does not reset existing conversations, agents, Codex choices,
or encrypted E2B settings. `--shared` and `--isolated` retain their existing profile-selection meanings.

`bun run dev:prepare` and `bun run dev:bootstrap` also prepare dependencies only by default.
Use `--with-services` on these commands only when preparing the explicit integration stack; that
path retains local service identity, Account API migrations, and missing-profile test data.

## Explicit self-hosted service development

| Command | Services and preparation |
| --- | --- |
| `bun run dev:api` | Account API only; prepares its local D1 database |
| `bun run dev:remote` | Signal only; prepares service identity but no D1 migration |
| `bun run dev --with-services` or `bun run dev:all` | Account API, Signal, and the app |
| `bun run dev:test-client` | Account API, Signal, host app, and test client |
| `bun run dev:slack` | Explicit service stack and the existing Slack development tunnels |

For explicit local integration stacks, the launcher passes the allocated local Account API URL as
`OPENBOT_SELF_HOSTED_API_URL`. The host/test-client development roles remain available and use the
HTTP test connection by default. An explicitly selected WebRTC test still needs the operator's
own configured control plane. No mode falls back to the upstream production account service.

For an externally deployed account service, set both `OPENBOT_SELF_HOSTED_API_URL=https://account.example.com`
and `OPENBOT_SELF_HOSTED_SIGNAL_URL=wss://signal.example.com/v1/signal`. The latter permits one
exact Signal origin in the desktop CSP. The independent launcher preserves these settings and
continues to discard the original service settings. Do not configure a wildcard WebSocket origin.

The original phone App can use an own-service QR from **Settings → Mobile Connect**. The desktop
first signs in to the own account service, registers its existing host identity, and connects to
Signal. A QR is shown only after this succeeds. A saved publication grant binds the account ID,
account origin, host ID and fingerprint. Restart restores only that exact grant; sign-out clears
it and closes remote access without closing the local workspace.

An own Cloudflare deployment can use the native account Worker in
`apps/auth-api/src/independent-worker-entry.ts`, a separate D1 database and private avatar R2 bucket,
a named Tunnel to the existing Mac Signal, and Cloudflare Realtime TURN. Tunnel carries HTTP/WSS;
TURN carries encrypted WebRTC relay traffic. Both OpenBot and the Mac must remain running.
`scripts/prepare-independent-account.ts` is not an installer: its named resource arguments
generate a private own-service Wrangler configuration, and do not load the original production env.
`bun scripts/run-independent-mobile.ts --prepare` prepares a separate encrypted identity from the
operator's private resource manifest; `--start` runs the local Signal and Tunnel in the foreground.
It installs no system service. Keep the private `.openbot` directory; its signing identity must
match the Worker secrets. Do not copy the repository's original signing keys.

The native account Worker reuses the existing API handlers and all account database migrations.
Its Cloudflare email binding sends codes only to the operator's explicit, verified destination
allowlist. It never returns a development code. No marketing pages or payment routes are exposed.
Cloudflare currently includes a shared monthly 1,000 GB allowance for SFU/TURN, then charges
$0.05 per GB of egress; Workers, D1 and R2 have separate allowances. See the current
[Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) before use.

### Gemini account model lists

The local desktop retains the model metadata that each Gemini account already discovered during
initialization. It filters the model picker and backup choices by the selected account. Reading this
catalog starts no provider process or model probe. A model update keeps existing assistant identity,
threads and model selection. Account removal checks all current and queued selections before any
assignment is moved to the default account.

This metadata is a local IPC extension. Released Team API model lists and decoders retain their
previous primary-account catalog, so an original phone App does not have to understand the new field.
No model is added by name unless that account's runtime returned it. Google controls plan eligibility;
refer to the current [Antigravity model table](https://antigravity.google/docs/models).

`--hosting=test` requires `OPENBOT_HOSTING_TEST_API_URL` or `OPENBOT_SELF_HOSTED_API_URL` pointing to
the operator's own HTTPS service (or a loopback development service). The previous vendor test
Worker is rejected. The test profile is scoped to that API origin; earlier test profiles are kept.
The existing test developer key is required for a real hosting test, but is never read during a
dry run.

`bun scripts/dev-services.ts app --dry-run` reports the app-only command without starting it.
The same option works with `api`, `remote`, `all`, `test-client`, and `--with-services`.
`bun scripts/independent-dev-launch-e2e.ts` checks these CLI plans and preparation against temporary
files. It launches no application or Account API service and does not modify the active profile.

## Packaged application recovery

The archive integrity watcher remains active. If another process changes `app.asar`, its warning
asks the user to reinstall from their own build or backup. The default warning has only a Close
button and does not open an upstream download page.

An operator can set `OPENBOT_RECOVERY_URL` to their own HTTPS recovery page. The warning then offers
an explicit action to open it; Close remains the default action. URLs with credentials, query
parameters, fragments, original product domains, or the original GitHub repository are rejected.

## Explicit host release sources

### 安装锁定的开源远程桌面组件

Sunshine 与 Moonlight Web 是本机远程桌面的独立开源组件，不是原站账号、计费或应用更新服务。
默认启动仍不会下载原站组件。需要安装仓库已经锁定的公开组件发布包时，显式运行：

```sh
OPENBOT_ALLOW_PINNED_OPEN_SOURCE_RUNTIME=1 bun run prepare:remote-desktop-runtime
bun run verify:remote-desktop-runtime
```

这个开关只允许 `native-runtime.lock.json` 已有的 GitHub 发布记录，不选择最新版本，也不接受另一个
仓库或下载地址。下载不使用 `GITHUB_TOKEN`；发布清单、归档、源码、许可证和文件哈希校验仍保留。
安装位置是本仓库的 `build/remote-desktop-runtime/`，不安装系统服务，也不恢复原站商业服务或自动更新。
组件安装后需重启这份开发实例，因为主机在启动时读取组件路径。然后在 **服务器设置 → 远程桌面**
重新检查权限；这里需要保持运行 Sunshine 的 macOS 用户处于图形登录会话，不需要 Sunshine 云账号。

如果不使用公开发布包，仍可配置自己的 `OPENBOT_REMOTE_DESKTOP_ARTIFACT_BASE_URL`，或使用
`OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD=1 bun run prepare:remote-desktop-runtime` 从锁定源码构建。

### 自己的主机安装与更新发布源

The Linux server installer, Linux hosted updater, and macOS host manager have no default release
repository. Set `OPENBOT_RELEASE_REPOSITORY=YOUR-OWNER/YOUR-REPOSITORY` to your own GitHub releases.
The Linux installer also accepts `--release-repository YOUR-OWNER/YOUR-REPOSITORY`. The original
repository and malformed values are rejected before a download, package installation, or application
replacement. Linux keeps SHA-512 manifest checks and exact artifact names. macOS keeps strict code
signature, Gatekeeper, bundle ownership, ACL, and process checks.

For the macOS manager, set `OPENBOT_HOST_SIGNING_TEAM_ID` to the ten-character Apple team ID that
signs your build. The required bundle identifier stays `app.openbot.desktop`. Supply both settings
in the operator-controlled LaunchDaemon environment; the original publisher's signing team is no
longer a default. These settings do not disable signing or permit an unsigned application.

Linux stores the explicitly selected repository in `/opt/OpenBot/hosted/release-repository` when
installing its service files. Update units read it as data and reject a symlink, non-root owner,
or group/other write permission. Staged builds carry a source record. A legacy staged build with
no source record, or a build from another source, is kept and refused instead of being installed.
The active application and user data are not replaced in that case.

Both Linux scripts accept `--help` and `--dry-run` without root. A dry run validates the source and
prints the manifest/artifact paths without downloading or changing the system. The focused
`bun scripts/independent-deployment-e2e.ts` exercises those paths and refusal paths with temporary
files and blocked system commands; it does not deploy or install a release.
