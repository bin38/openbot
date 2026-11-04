# Independent plugins and local catalogs

The Apps catalog ships with the desktop app and does not need an upstream account. It contains
35 entries, including X, X Account, Feishu, and GitHub MCP. The public MCP directory is a separate
discovery source; it is not a copy of Composio's toolkit catalog or Codex's private connector service.

## X and Feishu

- **X** connects to `https://api.x.com/mcp` with the user's own bearer token. An app-only token is
  read-only. Available operations follow X's token permissions and API plan.
- **X Account** starts the official pinned `@xdevplatform/xurl@1.3.4` bridge. Configure the user's own
  X developer application and finish its local OAuth login before pressing Connect. The setup dialog
  shows those steps first. It does not pretend that X supports MCP dynamic OAuth registration.
- **Feishu** starts the official pinned `@larksuiteoapi/lark-mcp@0.5.1` with `APP_ID` and `APP_SECRET`
  environment variables. This is application identity. Personal-user access requires the official
  CLI's separate OAuth setup; app credentials do not grant every personal document or chat.
- **GitHub MCP** uses GitHub's official endpoint and a user-owned PAT. It does not use the upstream
  OpenBotGit OAuth client or token broker.

Configuring an entry does not authorize an agent to post a message or perform another account action.
Each service still requires its own account, permissions, and any usage plan it imposes.

## Public MCP directory

Open Marketplace → Apps → **Public MCP directory**. Search and paging contact only the official
Registry. Public metadata is cached on this computer for offline discovery; it contains no values
entered in credential fields. Browsing never starts an executable or connects to a listed MCP.

The importer supports HTTPS Streamable HTTP endpoints and npm stdio packages pinned to an exact
version. It displays the address or program and arguments before use. Required environment variables
and headers are filled by the user; credential-field defaults supplied by a publisher are ignored.
The importer rejects credential-bearing URLs and package-runner overrides. SSE, OCI, and argument
templates that need a richer editor remain visible but require manual MCP configuration.

Test connects using the existing MCP test path. Save creates a new server and does not replace an
existing ID. A connection that has not passed its test is saved disabled, so a catalog entry is not
misrepresented as a working integration. Browser sign-in and further edits remain available in
Server settings → MCP.

MCP environment variables and static headers currently use the existing host-local SQLite storage.
They are redacted from logs, but are not OS-encrypted by this change. OAuth grants continue to use
the existing encrypted grant store. E2B credentials use their separate encrypted store.

## Local agent and skill catalogs

In the independent edition, discovery, publication records and templates use this computer's local
library. Agent/template snapshots contain instructions, routines and selected skill information, not
workspace files or conversation memories. Local updates preserve IDs; a corrupt catalog is retained
and blocks writes until it is repaired.

Existing installed skills remain on disk. The independent catalog does not fetch old versions from
the upstream store. Import an owned copy into the local library when a new install needs one.
Local template snapshots can embed installed skill instructions through the existing template flow.

Copied `openbot://` links are shortcuts to data in this profile. They are not publicly hosted pages
and do not upload a package or template to a vendor account. Cross-device distribution needs an
explicit export or a separately configured self-hosted service.

## Verification

`bun scripts/independent-marketplace-e2e.ts` exercises a real loopback Registry fixture, bounded
metadata parsing, paging, cache recovery, SQLite MCP configuration, and local catalog persistence.
It does not sign in to X, Feishu, GitHub, or another user's account. Existing MCP import E2E covers
the shared real HTTP and stdio connection path.
