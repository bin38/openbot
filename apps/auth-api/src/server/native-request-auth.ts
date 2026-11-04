import { env, waitUntil } from "cloudflare:workers";
import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type AccountAnalytics, createAccountAnalytics } from "./account-analytics";
import type { AccountAttribution } from "./account-attribution";
import { AuthService, AuthServiceError } from "./auth-service";
import { D1AuthRepository } from "./d1-auth-repository";
import { runApiEffect } from "./effect-runtime";
import { createEmailCodeDelivery, createTeamInviteEmailDelivery } from "./email-delivery";
import { adoptUnlinkedHostedSites } from "./hosted-site-server";
import { JsonBodyError } from "./json-body";
import {
  deliverPendingRemoteAuthEvents,
  notifyAccountProfileChanged,
  RemoteControlPlane,
  RemoteControlPlaneError,
  verifyRemoteServiceSignature,
} from "./remote-control-plane";
import { type AccountWorkerBindings, requireAccountWorkerBindings, type TeamInviteEmailDelivery } from "./types";

export function accountAnalytics(
  bindings: Pick<AccountWorkerBindings, "DB" | "OPENPANEL_CLIENT_ID" | "OPENPANEL_CLIENT_SECRET">,
): AccountAnalytics {
  return createAccountAnalytics({
    clientId: bindings.OPENPANEL_CLIENT_ID,
    clientSecret: bindings.OPENPANEL_CLIENT_SECRET,
    fetch: (input, init) => fetch(input, init),
    schedule,
    database: bindings.DB,
  });
}

export function requestAvatarBucket(): R2Bucket {
  const bindings = requireAccountWorkerBindings(env);
  return bindings.AVATARS;
}

/** Keeps the existing site adoption operation for editions that publish hosted sites. */
export function requestAdoptUnlinkedHostedSites(
  userId: string,
  serverId: string,
): ReturnType<typeof adoptUnlinkedHostedSites> {
  if (INDEPENDENT_EDITION) return Effect.succeed(0);
  return adoptUnlinkedHostedSites(requireAccountWorkerBindings(env).DB, userId, serverId, Date.now());
}

export function requestUser(request: Request) {
  const token = bearerToken(request);
  if (!token) return Effect.succeed(null);
  return requestAuthService().authenticate(token);
}

export function requestTeamInviteEmailDelivery(): TeamInviteEmailDelivery | null {
  const bindings = requireAccountWorkerBindings(env);
  return createTeamInviteEmailDelivery(bindings, accountAnalytics(bindings));
}

export function requestRemoteControlPlane(): RemoteControlPlane {
  return new RemoteControlPlane(requireAccountWorkerBindings(env), { schedule });
}

export function verifyRemoteServiceRequest(request: Request, body: string) {
  const secret = requireAccountWorkerBindings(env).REMOTE_AUTH_WEBHOOK_SECRET;
  if (!secret) return Effect.succeed(false);
  return verifyRemoteServiceSignature(
    secret,
    body,
    request.headers.get("OpenBot-Timestamp") ?? "",
    request.headers.get("OpenBot-Signature") ?? "",
  );
}

export function remoteControlPlaneErrorResponse(error: unknown): Response {
  if (error instanceof RemoteControlPlaneError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token && token.length <= 512 ? token : null;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof JsonBodyError) {
    return apiError(error.status, error.code, error.message);
  }
  if (error instanceof AuthServiceError) {
    const response = apiError(error.status, error.code, error.message);
    if (error.retryAfterSeconds !== undefined) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return response;
  }
  // The reference is random, so it holds no user data. The log line shows the same value, so a code
  // that a user copies identifies this log line. The log shows only the error type, not its message.
  const reference = `auth/${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  console.error("Account service request failed:", reference, errorType(error));
  return json(
    { error: { code: "internal_error", message: "The account service could not complete the request.", reference } },
    500,
  );
}

function errorType(error: unknown): string {
  if (isDynamicRecord(error) && isString(error._tag)) return error._tag;
  return error instanceof Error ? error.name : typeof error;
}

/** Starts background work in the active Worker invocation. */
export function schedule<E>(work: Effect.Effect<void, E>): void {
  waitUntil(runApiEffect(work));
}

/** Shared account service construction. Browser attribution is supplied only by the web adapter. */
export function createAccountAuthService(
  bindings: AccountWorkerBindings,
  attribution?: AccountAttribution,
): AuthService {
  const exposeDevelopmentCode = bindings.AUTH_EXPOSE_DEVELOPMENT_CODE === "true";
  const analytics = accountAnalytics(bindings);
  return new AuthService({
    repository: new D1AuthRepository(bindings.DB),
    delivery: exposeDevelopmentCode ? null : createEmailCodeDelivery(bindings, analytics),
    exposeDevelopmentCode,
    flushSessionRevocations: () => Effect.sync(() => schedule(deliverPendingRemoteAuthEvents(bindings, Date.now()))),
    profileChanged: (userId) => notifyAccountProfileChanged(bindings, userId, schedule),
    analytics,
    ...(attribution ? { attribution } : {}),
  });
}

export function requestAuthService(): AuthService {
  return createAccountAuthService(requireAccountWorkerBindings(env));
}
