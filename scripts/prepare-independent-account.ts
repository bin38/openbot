import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEmailAddress } from "@openbot/contracts/validation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Writes only an operator's selected resources. It never loads the original deployment config or secrets. */
export async function prepareIndependentAccount(input: {
  name: string;
  accountId: string;
  databaseId: string;
  databaseName: string;
  avatarBucket: string;
  origin: string;
  signalOrigin: string;
  ownerEmail: string;
  senderEmail: string;
  ticketKeyId: string;
}): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(input.name)) throw new Error("Use a valid Worker name.");
  if (!/^[a-f0-9]{32}$/iu.test(input.accountId)) throw new Error("Use the selected Cloudflare account ID.");
  if (!/^[a-f0-9-]{36}$/iu.test(input.databaseId)) throw new Error("Use the created D1 database ID.");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(input.databaseName) || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(input.avatarBucket))
    throw new Error("Use the created D1 and R2 resource names.");
  const origin = ownedOrigin(input.origin);
  const signal = ownedOrigin(input.signalOrigin);
  const ownerEmail = normalizeEmailAddress(input.ownerEmail);
  const senderEmail = normalizeEmailAddress(input.senderEmail);
  if (!ownerEmail || !senderEmail) throw new Error("Set the verified destination and sender email addresses.");
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.ticketKeyId)) throw new Error("Use the selected ticket key ID.");
  const path = join(ROOT, ".openbot", "self-hosted-account", "wrangler.jsonc");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        name: input.name,
        account_id: input.accountId,
        main: join(ROOT, "apps/auth-api/src/independent-worker-entry.ts"),
        compatibility_date: "2026-08-18",
        compatibility_flags: ["nodejs_compat"],
        minify: true,
        workers_dev: false,
        preview_urls: false,
        upload_source_maps: false,
        observability: { enabled: false },
        routes: [{ pattern: origin.hostname, custom_domain: true }],
        triggers: { crons: ["*/5 * * * *"] },
        vars: {
          AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
          AUTH_ALLOWED_EMAILS: ownerEmail,
          EMAIL_FROM: senderEmail,
          REMOTE_TICKET_KEY_ID: input.ticketKeyId,
          REMOTE_SIGNAL_URL: `wss://${signal.host}/v1/signal`,
          REMOTE_AUTH_WEBHOOK_URL: `https://${signal.host}/internal/auth-events`,
        },
        secrets: { required: ["REMOTE_TICKET_PRIVATE_JWK", "REMOTE_TICKET_PUBLIC_JWKS", "REMOTE_AUTH_WEBHOOK_SECRET"] },
        d1_databases: [
          {
            binding: "DB",
            database_name: input.databaseName,
            database_id: input.databaseId,
            migrations_dir: join(ROOT, "apps/auth-api/migrations"),
          },
        ],
        r2_buckets: [{ binding: "AVATARS", bucket_name: input.avatarBucket }],
        send_email: [
          { name: "EMAIL", allowed_destination_addresses: [ownerEmail], allowed_sender_addresses: [senderEmail] },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return path;
}

function ownedOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    ["openbot.run", "openbot.site"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  ) {
    throw new Error("Use your own HTTPS origin without a path or credentials.");
  }
  return url;
}

if (import.meta.main) {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const split = arg.indexOf("=");
      return [arg.slice(0, split), arg.slice(split + 1)] as const;
    }),
  );
  function required(name: string): string {
    const value = args.get(`--${name}`);
    if (!value) throw new Error(`Missing --${name}=...`);
    return value;
  }
  const config = await prepareIndependentAccount({
    name: required("name"),
    accountId: required("account-id"),
    databaseId: required("database-id"),
    databaseName: required("database-name"),
    avatarBucket: required("avatar-bucket"),
    origin: required("origin"),
    signalOrigin: required("signal-origin"),
    ownerEmail: required("owner-email"),
    senderEmail: required("sender-email"),
    ticketKeyId: required("ticket-key-id"),
  });
  // Machine-readable: the path contains no credential or email address.
  process.stdout.write(`${config}\n`);
}
