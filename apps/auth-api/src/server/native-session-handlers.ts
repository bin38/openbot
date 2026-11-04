import { isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { z } from "zod";
import { sha256 } from "./crypto";
import { runApiResponse } from "./effect-runtime";
import { JSON_BODY_LIMIT, readJsonObject, readRequestBytes } from "./json-body";
import type { NativeApiHandlers } from "./native-api-types";
import {
  apiError,
  bearerToken,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestUser,
  verifyRemoteServiceRequest,
} from "./native-request-auth";

// Shared by the original native API routes and the independent Worker.
export const sessionsHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (!isString(body.hostId)) return apiError(400, "invalid_remote_request", "The host ID is invalid.");
        return json(yield* requestRemoteControlPlane().startSession(user.id, body.hostId, yield* sha256(token)), 201);
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const sessionTicketHandlers = {
  POST: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (!isString(body.clientPublicKey)) {
          return apiError(400, "invalid_remote_request", "The client public key is required.");
        }
        return json(
          yield* requestRemoteControlPlane().issueSessionTicket(user.id, params.sessionId, body.clientPublicKey),
        );
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ sessionId: string }>;

export const sessionEndHandlers = {
  POST: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestRemoteControlPlane().endSession(user.id, params.sessionId);
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ sessionId: string }>;

const resumeClaimsSchema = z.object({
  sessionId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  membershipId: z.string().min(1).max(256),
  role: z.enum(["host", "owner", "admin", "member"]),
  authEpoch: z.number().int().nonnegative(),
  sessionExpiresAt: z.number().int().positive(),
});

export const resumeValidateHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = new TextDecoder().decode(yield* readRequestBytes(request, JSON_BODY_LIMIT));
        if (!(yield* verifyRemoteServiceRequest(request, body))) {
          return apiError(401, "invalid_signature", "The Remote service signature is invalid.");
        }
        let parsed: ReturnType<typeof resumeClaimsSchema.safeParse>;
        try {
          parsed = resumeClaimsSchema.safeParse(JSON.parse(body));
        } catch {
          return apiError(400, "invalid_resume_claims", "The resume claims are invalid.");
        }
        if (!parsed.success) return apiError(400, "invalid_resume_claims", "The resume claims are invalid.");
        return json({ valid: yield* requestRemoteControlPlane().validateResumeClaims(parsed.data) });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

function createRemoteJwksResponse(): Response {
  return Response.json(requestRemoteControlPlane().publicJwks(), {
    headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

export const jwksHandlers = { GET: createRemoteJwksResponse } satisfies NativeApiHandlers<Record<never, never>>;
