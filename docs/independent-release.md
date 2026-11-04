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
