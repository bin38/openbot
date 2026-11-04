import { isString } from "@openbot/contracts/runtime-values";
import { isUuidV4 } from "@openbot/contracts/validation";
import { Effect } from "effect";
import { readAnalyticsAnswer } from "./auth-service";
import {
  AvatarUploadError,
  avatarObjectKey,
  readAvatarUpload,
  removeAccountAvatar,
  storeAccountAvatar,
} from "./avatar-storage";
import { sha256 } from "./crypto";
import { runApiResponse } from "./effect-runtime";
import { readJsonObject } from "./json-body";
import type { NativeApiHandlers } from "./native-api-types";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  requestAuthService,
  requestAvatarBucket,
  requestRemoteControlPlane,
  requestTeamInviteEmailDelivery,
} from "./native-request-auth";
import { requestSourceIp } from "./source-ip";
import { sendTeamInviteEmail } from "./team-invite-email";

// Shared by the original native API routes and the independent Worker.
export const emailStartHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.email)) {
          return apiError(400, "invalid_email", "Enter a valid email address.");
        }
        const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
        return json(yield* requestAuthService().startEmailSignIn(body.email, requestSourceIp(request), idempotencyKey));
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const emailVerifyHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.challengeId) || !isString(body.code)) {
          return apiError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
        }
        return json(
          yield* requestAuthService().verifyEmailCode({
            challengeId: body.challengeId,
            code: body.code,
            sourceIp: requestSourceIp(request),
            surface: "desktop",
          }),
        );
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const logoutHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const service = requestAuthService();
        const user = yield* service.authenticateDesktopSession(token);
        if (!user) {
          return apiError(401, "unauthorized", "The session is invalid.");
        }
        yield* requestRemoteControlPlane().endAccountSession(user.id, yield* sha256(token));
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const meHandlers = {
  GET: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const user = yield* requestAuthService().authenticate(token);
        return user ? json(user) : apiError(401, "unauthorized", "The session is invalid.");
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const profileHandlers = {
  PATCH: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (!isString(body.name)) {
          return apiError(400, "invalid_profile_name", "Enter a valid display name.");
        }
        return json(yield* requestAuthService().updateName(token, body.name));
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const analyticsHandlers = {
  PUT: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const answer = readAnalyticsAnswer(yield* readJsonObject(request));
        if (!answer) return apiError(400, "invalid_analytics_preference", "The analytics setting is not valid.");
        return json(yield* requestAuthService().updateAnalytics(token, answer));
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const avatarHandlers = {
  PUT: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const service = requestAuthService();
        const user = yield* service.authenticate(token);
        if (!user) return apiError(401, "unauthorized", "The session is invalid.");
        const upload = yield* readAvatarUpload(request);
        return json(yield* storeAccountAvatar(service, requestAvatarBucket(), token, user, upload));
      }),
      (error) => {
        if (error instanceof AvatarUploadError) {
          return apiError(error.status, error.code, error.message);
        }
        return authErrorResponse(error);
      },
    ),
  DELETE: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const service = requestAuthService();
        const user = yield* service.authenticate(token);
        if (!user) return apiError(401, "unauthorized", "The session is invalid.");
        return json(yield* removeAccountAvatar(service, requestAvatarBucket(), token, user));
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const avatarReadHandlers = {
  GET: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const version = new URL(request.url).searchParams.get("v") ?? "";
        if (!isUuidV4(params.userId) || !isUuidV4(version)) {
          return new Response("Not found", { status: 404 });
        }
        const object = yield* Effect.promise(() => requestAvatarBucket().get(avatarObjectKey(params.userId, version)));
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: object.httpEtag,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }),
      (error) => {
        throw error;
      },
    ),
} satisfies NativeApiHandlers<{ userId: string }>;

export const teamTicketHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (!isString(body.serverId)) {
          return apiError(400, "invalid_server_id", "The team server ID is invalid.");
        }
        return json(yield* requestAuthService().issueTeamAuthTicket(token, body.serverId, requestSourceIp(request)));
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const teamRedeemHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.ticket) || !isString(body.serverId)) {
          return apiError(400, "invalid_team_ticket", "The team ticket is invalid.");
        }
        const user = yield* requestAuthService().redeemTeamAuthTicket(
          body.ticket,
          body.serverId,
          requestSourceIp(request),
        );
        if (!user) return apiError(401, "invalid_team_ticket", "The team ticket is invalid or expired.");
        // The host that redeems the ticket can belong to another user; it gets the member's identity only.
        return json({ id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl });
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const inviteEmailHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const auth = requestAuthService();
        const user = yield* auth.authenticate(token);
        if (!user) return apiError(401, "unauthorized", "The session is invalid.");
        const body = yield* readJsonObject(request);
        yield* sendTeamInviteEmail(
          { auth, remote: requestRemoteControlPlane(), delivery: requestTeamInviteEmailDelivery },
          user,
          body,
          requestSourceIp(request),
        );
        return new Response(null, { status: 204 });
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;
