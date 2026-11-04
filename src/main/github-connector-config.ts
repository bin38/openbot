// The GitHub App that the built-in GitHub connection signs in to.
//
// `bun scripts/create-github-app.ts` creates the app and prints its Client ID. A Client ID is
// public: device flow and refresh need nothing else, and the client secret never ships.

import { createHash } from "node:crypto";

export interface GitHubAppConfig {
  clientId: string;
  slug: string;
}

/** A user-owned app only. No vendor OAuth application is used as a fallback. */
export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const clientId = env.OPENBOT_GITHUB_CLIENT_ID?.trim();
  const slug = env.OPENBOT_GITHUB_APP_SLUG?.trim();
  if (!clientId || !slug) return null;
  if (clientId === "Iv23lik5pzHz70cb0RUL" || slug === "openbotgit") return null;
  if (!/^[A-Za-z0-9.]+$/u.test(clientId) || !/^[a-z0-9-]+$/u.test(slug)) return null;
  return { clientId, slug };
}

/** An app switch never reads refresh tokens issued to the previous OAuth application. */
export function githubAppStorageFile(app: GitHubAppConfig | null): string {
  if (!app) return "github-connector-independent.json";
  const identity = createHash("sha256").update(app.clientId).digest("hex").slice(0, 24);
  return `github-connector-${identity}.json`;
}
