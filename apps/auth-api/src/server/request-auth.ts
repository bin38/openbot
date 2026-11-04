import { env } from "cloudflare:workers";
import { HOSTING_DEVELOPER_KEY_HEADER } from "@openbot/contracts/hosted-servers";
import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { AccountAttribution } from "./account-attribution";
import { adminTokenMatches } from "./admin-token";
import { AgentMarketplace, AgentMarketplaceError } from "./agent-marketplace";
import { AgentTemplates } from "./agent-templates";
import { type FcmRelaySender, sharedFcmSender } from "./android-notification-relay";
import { AuthOperationError, type AuthService } from "./auth-service";
import { BillingError, type BillingService } from "./billing-service";
import type { ContactMessageServices } from "./contact-message";
import { D1AuthRepository } from "./d1-auth-repository";
import { DiscordAppError, DiscordAppService } from "./discord-app";
import { createContactMessageDelivery } from "./email-delivery";
import { GitHubInstallationTokens, GitHubInstallationTokensError } from "./github-installation-tokens";
import { createHostedBilling } from "./hosted-billing";
import { type HostedServerService, HostedServerServiceError } from "./hosted-server-service";
import { HostedSiteInputError } from "./hosted-site-contract";
import { enforceHostedSiteReportRateLimit as enforceReportRateLimit } from "./hosted-site-request-policy";
import { resolveHostedSiteScope } from "./hosted-site-server";
import { HostedSiteService } from "./hosted-site-service";
import { type ApnsRelaySender, sharedApnsSender } from "./live-activity-relay";
import { MarketplaceQueryError } from "./marketplace-pagination";
import {
  enforceMarketplaceMutation,
  type MarketplaceMutationKind,
  MarketplaceRateLimitError,
} from "./marketplace-request-policy";
import {
  accountAnalytics,
  apiError,
  authErrorResponse,
  bearerToken,
  createAccountAuthService,
  remoteControlPlaneErrorResponse,
  schedule,
} from "./native-request-auth";
import { deliverPendingRemoteAuthEvents, RemoteControlPlane, RemoteControlPlaneError } from "./remote-control-plane";
import { SkillMarketplace, SkillMarketplaceError } from "./skill-marketplace";
import { SlackAppError, SlackAppService } from "./slack-app";
import { requireAccountWorkerBindings, requireWorkerBindings } from "./types";

export function requestAccountAttribution(): AccountAttribution {
  const bindings = requireWorkerBindings(env);
  return new AccountAttribution({ database: bindings.DB, analytics: accountAnalytics(bindings) });
}

export function requestAuthService(): AuthService {
  const bindings = requireAccountWorkerBindings(env);
  return createAccountAuthService(
    bindings,
    new AccountAttribution({ database: bindings.DB, analytics: accountAnalytics(bindings) }),
  );
}

export function requestSkillMarketplace(): SkillMarketplace {
  const bindings = requireWorkerBindings(env);
  return new SkillMarketplace(bindings);
}

export function requestAgentMarketplace(): AgentMarketplace {
  return new AgentMarketplace(requireWorkerBindings(env));
}

export function requestAgentTemplates(): AgentTemplates {
  return new AgentTemplates(requireWorkerBindings(env));
}

/** The sites that a signed-in `/v1/sites` request can see and change. See `resolveHostedSiteScope`. */
export function requestHostedSiteScope(request: Request, userId: string) {
  return resolveHostedSiteScope(requireWorkerBindings(env).DB, userId, request);
}

export function requestHostedSiteService(): HostedSiteService {
  if (INDEPENDENT_EDITION) {
    throw new HostedSiteInputError(404, "service_unavailable", sourceText("error.auth.independentServiceUnavailable"));
  }
  const bindings = requireWorkerBindings(env);
  return new HostedSiteService(
    bindings.DB,
    bindings.SITES,
    Date.now,
    bindings.SITE_REPORT_HASH_SECRET,
    bindings.SITE_LOCAL_ORIGIN,
  );
}

/** The billing service, or null when this deployment has no Stripe key. */
export function requestBillingService(): BillingService | null {
  if (INDEPENDENT_EDITION) return null;
  return requestHostedBilling().billing;
}

export function billingErrorResponse(error: unknown): Response {
  if (error instanceof BillingError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function requireSitePublishingEnabled(): void {
  const bindings = requireWorkerBindings(env);
  if (bindings.SITE_PUBLISH_ENABLED !== "true") {
    throw new HostedSiteInputError(409, "publishing_disabled", "Site publishing is temporarily disabled.");
  }
  if (bindings.SITE_COOKIE_ISOLATION_READY !== "true") {
    throw new HostedSiteInputError(
      409,
      "cookie_isolation_unavailable",
      "Site publishing is disabled until openbot.site has public-suffix cookie isolation.",
    );
  }
}

export function hostedSiteErrorResponse(error: unknown): Response {
  if (error instanceof HostedSiteInputError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

/**
 * One service for each key, so the imported key and the app ID are read once for each isolate. Only
 * resolved values are kept: workerd refuses a promise that another request made.
 */
let githubInstallationTokens: { key: string; service: GitHubInstallationTokens } | null = null;

export function requestGitHubInstallationTokens(): GitHubInstallationTokens {
  const bindings = requireWorkerBindings(env);
  const clientId = bindings.GITHUB_APP_CLIENT_ID?.trim();
  const privateKey = bindings.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!clientId || !privateKey) {
    throw new GitHubInstallationTokensError(503, "github_app_unavailable", "The OpenBot GitHub App is not configured.");
  }
  const key = `${clientId}\u0000${privateKey}`;
  if (githubInstallationTokens?.key !== key) {
    githubInstallationTokens = {
      key,
      service: new GitHubInstallationTokens({ clientId, privateKey, fetch: (input, init) => fetch(input, init) }),
    };
  }
  return githubInstallationTokens.service;
}

export const enforceGitHubTokenRateLimit = Effect.fn("GitHub.enforceTokenRateLimit")(function* (sourceIp: string) {
  const result = yield* Effect.tryPromise({
    try: () => requireWorkerBindings(env).GITHUB_TOKEN_RATE_LIMITER.limit({ key: `ip:${sourceIp}` }),
    catch: () =>
      new GitHubInstallationTokensError(503, "github_app_unavailable", "The OpenBot GitHub App is unavailable."),
  });
  if (!result.success) {
    return yield* new GitHubInstallationTokensError(
      429,
      "rate_limited",
      "Too many GitHub token requests. Try again later.",
    );
  }
});

export function githubInstallationTokensErrorResponse(error: unknown): Response {
  if (error instanceof GitHubInstallationTokensError) {
    const response = apiError(error.status, error.code, error.message);
    if (error.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
  return authErrorResponse(error);
}

/**
 * The Apple relay for Live Activity updates and notifications: the Apple sender and the limits for
 * each host. `null` when this Worker has no Apple key or no limiter, so the relay is off.
 */
export function requestApnsRelay(): {
  sender: ApnsRelaySender;
  /** A host sends a few updates a minute for each phone. More is a fault or misuse. */
  allow(hostId: string): Effect.Effect<boolean, AuthOperationError>;
  /** A host sends one notification for each event that waits for a member, under a separate limit. */
  allowNotification(hostId: string): Effect.Effect<boolean, AuthOperationError>;
} | null {
  const bindings = requireWorkerBindings(env);
  const { APNS_PRIVATE_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, APNS_ORIGIN, LIVE_ACTIVITY_RATE_LIMITER } = bindings;
  if (!APNS_PRIVATE_KEY || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC || !LIVE_ACTIVITY_RATE_LIMITER) return null;
  const origin = developmentApnsOrigin(APNS_ORIGIN);
  const limit = relayLimit(LIVE_ACTIVITY_RATE_LIMITER);
  return {
    sender: sharedApnsSender({
      // A deploy passes the key as one line, with `\n` for each line break.
      privateKey: APNS_PRIVATE_KEY.replaceAll("\\n", "\n"),
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
      topic: APNS_TOPIC,
      ...(origin ? { origin } : {}),
    }),
    allow: (hostId) => limit(`host:${hostId}`),
    allowNotification: (hostId) => limit(`notification:host:${hostId}`),
  };
}

/**
 * The Firebase relay for Android notifications: the Firebase sender and the notification limit of
 * each host, which it shares with iPhone notifications. `null` when this Worker has no valid service
 * account key or no limiter, so the relay is off.
 */
export function requestFcmRelay(): {
  sender: FcmRelaySender;
  allowNotification(hostId: string): Effect.Effect<boolean, AuthOperationError>;
} | null {
  const { FCM_SERVICE_ACCOUNT, LIVE_ACTIVITY_RATE_LIMITER } = requireWorkerBindings(env);
  if (!FCM_SERVICE_ACCOUNT || !LIVE_ACTIVITY_RATE_LIMITER) return null;
  const sender = sharedFcmSender(FCM_SERVICE_ACCOUNT);
  if (!sender) return null;
  const limit = relayLimit(LIVE_ACTIVITY_RATE_LIMITER);
  return { sender, allowNotification: (hostId) => limit(`notification:host:${hostId}`) };
}

function relayLimit(limiter: RateLimit) {
  return (key: string) =>
    Effect.tryPromise({
      try: () => limiter.limit({ key }),
      catch: () => new AuthOperationError({ message: "Account operation failed." }),
    }).pipe(Effect.map((result) => result.success));
}

/** Only a development server on this computer can stand in for Apple. */
function developmentApnsOrigin(value: string | undefined): string | undefined {
  return value && /^http:\/\/127\.0\.0\.1:\d+\/__dev\/apns$/u.test(value) ? value : undefined;
}

export function enforceMarketplaceMutationRateLimit(kind: MarketplaceMutationKind, principal: string) {
  return enforceMarketplaceMutation(requireWorkerBindings(env), kind, principal);
}

export function enforceHostedSiteReportRateLimit(sourceIp: string) {
  return enforceReportRateLimit(requireWorkerBindings(env), sourceIp);
}

export function marketplaceErrorResponse(error: unknown): Response {
  if (error instanceof AgentMarketplaceError) return apiError(error.status, error.code, error.message);
  return skillErrorResponse(error);
}

export function skillErrorResponse(error: unknown): Response {
  if (error instanceof MarketplaceQueryError) return apiError(400, error.code, error.message);
  if (error instanceof MarketplaceRateLimitError) {
    const response = apiError(error.status, error.code, error.message);
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof SkillMarketplaceError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export const requireSkillsAdmin = Effect.fn("Auth.requireSkillsAdmin")(function* (request: Request) {
  return yield* adminTokenMatches(requireWorkerBindings(env).SKILLS_ADMIN_TOKEN, bearerToken(request));
});

export const requireOperationsAdmin = Effect.fn("Auth.requireOperationsAdmin")(function* (request: Request) {
  return yield* adminTokenMatches(requireWorkerBindings(env).SITE_OPERATIONS_ADMIN_TOKEN, bearerToken(request));
});

export const requireServerClaimsAdmin = Effect.fn("Auth.requireServerClaimsAdmin")(function* (request: Request) {
  return yield* adminTokenMatches(requireWorkerBindings(env).SERVER_CLAIMS_ADMIN_TOKEN, bearerToken(request));
});

/** The limits and delivery of the site's contact form. */
export function requestContactMessageServices(): ContactMessageServices {
  const bindings = requireWorkerBindings(env);
  return {
    repository: new D1AuthRepository(bindings.DB),
    now: () => Date.now(),
    delivery: () => createContactMessageDelivery(bindings, accountAnalytics(bindings)),
  };
}

/** Pass the request when the call checks who can create servers, so its developer key counts. */
export function requestHostedServerService(request?: Request): HostedServerService {
  return requestHostedBilling(request?.headers.get(HOSTING_DEVELOPER_KEY_HEADER) ?? null).hosting;
}

function requestHostedBilling(developerKey: string | null = null) {
  if (INDEPENDENT_EDITION) {
    throw new BillingError(404, "service_unavailable", sourceText("error.auth.independentServiceUnavailable"));
  }
  const bindings = requireWorkerBindings(env);
  const remote = new RemoteControlPlane(bindings, { schedule });
  return createHostedBilling(bindings, {
    removeHost: (ownerUserId, hostId) => remote.deleteHost(ownerUserId, hostId),
    developerKey,
    planChanged: (hostId) => remote.planChanged(hostId),
    licenseChanged: (userId) => remote.licenseChanged(userId),
    schedule,
  });
}

export function hostedServerErrorResponse(error: unknown): Response {
  if (error instanceof HostedServerServiceError) return apiError(error.status, error.code, error.message);
  if (error instanceof BillingError) return apiError(error.status, error.code, error.message);
  if (error instanceof HostedSiteInputError) return apiError(error.status, error.code, error.message);
  return remoteControlPlaneErrorResponse(error);
}

/** A GitHub route ticket checks the host credential and then the GitHub sign-in. */
export function githubRouteErrorResponse(error: unknown): Response {
  if (error instanceof RemoteControlPlaneError) return remoteControlPlaneErrorResponse(error);
  return githubInstallationTokensErrorResponse(error);
}

export function requestSlackApp(): SlackAppService {
  const bindings = requireWorkerBindings(env);
  // The events are already in D1 and the cron redelivers them, so the answer does not wait.
  return new SlackAppService(bindings, {
    flushAuthEvents: () => Effect.sync(() => schedule(deliverPendingRemoteAuthEvents(bindings, Date.now()))),
  });
}

export function slackAppErrorResponse(error: unknown): Response {
  if (error instanceof SlackAppError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function requestDiscordApp(): DiscordAppService {
  const bindings = requireWorkerBindings(env);
  // The events are already in D1 and the cron redelivers them, so the answer does not wait.
  return new DiscordAppService(bindings, {
    flushAuthEvents: () => Effect.sync(() => schedule(deliverPendingRemoteAuthEvents(bindings, Date.now()))),
  });
}

export function discordAppErrorResponse(error: unknown): Response {
  if (error instanceof DiscordAppError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function publicMarketplaceJson(value: unknown): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300, stale-if-error=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  remoteControlPlaneErrorResponse,
  requestAvatarBucket,
  requestRemoteControlPlane,
  requestTeamInviteEmailDelivery,
  requestUser,
  schedule,
  verifyRemoteServiceRequest,
} from "./native-request-auth";
