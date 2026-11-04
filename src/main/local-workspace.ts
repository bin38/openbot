import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { LocalWorkspaceProfile } from "@openbot/contracts/product-edition";
import { Effect } from "effect";
import { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamStore } from "./team-store";

export const LOCAL_TEAM_FILE = "independent-local-team-v1.json";
export const LOCAL_REMOTE_SERVERS_FILE = "independent-remote-servers-v1.json";

/** No fallback to the upstream service, and no reuse of a session from another origin. */
export function independentAccountService(userData: string, configuredUrl?: string) {
  if (!configuredUrl?.trim())
    return {
      enabled: false,
      apiUrl: "http://127.0.0.1:9",
      storagePath: join(userData, "independent-account-disabled.bin"),
      teamStoragePath: join(userData, "independent-account-disabled-team.json"),
    };
  if (!URL.canParse(configuredUrl)) throw new Error("The self-hosted account URL must be a valid origin.");
  const url = new URL(configuredUrl);
  url.hostname = url.hostname.replace(/\.$/u, "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("The self-hosted account URL must be an HTTPS origin, or an HTTP loopback origin.");
  }
  if (url.hostname === "openbot.run" || url.hostname.endsWith(".openbot.run")) {
    throw new Error("Configure your own account service; the upstream service is not used by this edition.");
  }
  const origin = url.origin;
  const scope = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return {
    enabled: true,
    apiUrl: origin,
    storagePath: join(userData, `independent-account-${scope}.bin`),
    teamStoragePath: join(userData, `independent-account-${scope}-team.json`),
  };
}

/** A real password owner on a separate local host file. Old account-bound host files stay untouched. */
export const initializeLocalWorkspace = Effect.fn("LocalWorkspace.initialize")(function* (
  store: TeamStore,
  input: { serverName: string; ownerName: string; ownerUsername?: string; ownerSecret?: string },
) {
  if (!store.configured) {
    yield* store.configure(
      input.serverName,
      input.ownerUsername ?? "local",
      input.ownerSecret ?? randomBytes(32).toString("base64url"),
    );
  }
  const id = store.getOwnerMemberId();
  if (!id) return yield* new RemoteWorkflowError({ cause: new Error("The local workspace owner is unavailable.") });
  return { id, name: input.ownerName } satisfies LocalWorkspaceProfile;
});
