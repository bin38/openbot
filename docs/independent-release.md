# Independent macOS releases

The independent distribution uses `im.ily.openbot.desktop`, the bundle `OpenBot 独立版.app`, and
the profile `~/Library/Application Support/OpenBot Independent`. It does not replace the original
`OpenBot.app` or its profile. The internal name remains `OpenBot` so macOS uses the same Keychain
service name. macOS can still ask the user to allow a new application to read that service.

Build on an Apple silicon Mac:

```sh
bun run package:independent:mac -- \
  --account-url=https://account.example.com \
  --signal-url=wss://signal.example.com/v1/signal
```

The command prepares the pinned native components, builds the application, verifies its preload,
creates DMG and ZIP files, and runs the independent package verifier. Output is under
`dist/independent-macos/`. Add `--prepare-only` to inspect the generated builder configuration
without building. The public service resource contains only a version and the two service URLs.
Private account credentials, API keys, operator signing keys and databases are not packaged.

Gemini 1.4.5 uses a local WebSocket harness. On macOS with a system SOCKS proxy, its bundled
Python can fail to match `localhost:<port>` against the system bypass list. In the local Gemini
provider page, enable its dedicated proxy and enter an HTTP/HTTPS or SOCKS5 address. SOCKS5
authentication uses separate write-only fields and encrypted storage. OpenBot prepares a private
loopback HTTP bridge for Gemini and the Colab CLI, so their HTTP clients do not need a SOCKS
library. Local harness and callback traffic stays direct. The setting persists across app
restarts and needs no TUN mode or system proxy change. External browser pages and component
downloads retain their existing route. Never put operator proxy credentials in a build resource,
release note or plist.

This local build is ad-hoc signed, not Apple-notarized. It does not claim the original publisher's
Apple team or Universal Links domain. Fuses, renderer isolation, native component checks and the
Cua vendor signature remain in force. Keep the GPL licenses and exact corresponding source
archives with the release. Keep the original PolyForm license and notices.

Use the `independent-v<version>` tag for an independent release. The original production and
store-publication workflows are gated to the original repository. Review the source and built
archive before uploading assets; publish SHA-256 checksums with the installers.

## Move a working development profile

Stop the exact development instance after its active tasks finish. Make and verify a full rollback
copy of its profile before copying it to the independent profile directory. Do not use the generic
instance export: it removes credentials and changes agent IDs. Keep workspaces at their existing
paths. Never overwrite a pre-existing independent profile without a separate backup and a deliberate
merge plan.

Keep the original profile until the installed app has read its settings, decrypted its credentials,
found local Codex and reconnected the phone host. Do not run both profile copies as hosts: they
retain the same host key and replace each other's Signal connection. The installation handoff can
disable only the development checkout's public own-service overrides after verification; the
original account files remain as a rollback copy.

Signal and Cloudflare Tunnel remain separate operator services. This installer does not install a
system login service or put Tunnel/TURN secrets in the app. Keep the operator service process
running; after a Mac restart, start it with `scripts/run-independent-mobile.ts --start` before
using external phone connections.

An operator can run the same `--start` command through a macOS user LaunchAgent, with `RunAtLoad`,
`KeepAlive`, and a restart throttle. Install that login service only with the user's approval. Keep
credentials in the existing private operator files, never in the plist. The service still needs
this checkout, its toolchain and private configuration at their configured paths. It does not keep
a sleeping Mac online.

The launcher keeps numbered `mobile-run.<generation>.lock` records. It can recover after an absent
owner only when no recorded child is alive and both local service ports are free. A live or
ambiguous owner is not replaced. Prior records remain available, and child exits log only the
component, process ID, exit code and signal. A Signal outage does not expire an authenticated phone
session; a short pairing code's expiry applies only before that code is redeemed.
