import { decodeHostKeyHandover, type HostKeyHandover } from "@openbot/contracts/host-key-handover";
import { isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { isUuidV4 } from "@openbot/contracts/validation";
import { Effect } from "effect";
import { AvatarUploadError, readAvatarUpload } from "./avatar-storage";
import { runApiResponse } from "./effect-runtime";
import { hostLogoObjectKey, readHostLogo } from "./host-logo";
import { readJsonObject } from "./json-body";
import type { NativeApiHandlers } from "./native-api-types";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestAdoptUnlinkedHostedSites,
  requestAvatarBucket,
  requestRemoteControlPlane,
  requestUser,
} from "./native-request-auth";

// Shared by the original native API routes and the independent Worker.
export const hostRegisterHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (
          !isString(body.hostId) ||
          !isString(body.name) ||
          !isString(body.ownerMembershipId) ||
          !(body.rotateCredential === undefined || isBoolean(body.rotateCredential)) ||
          !(body.machineToken === undefined || isString(body.machineToken)) ||
          !(body.devicePublicKey === undefined || body.devicePublicKey === null || isString(body.devicePublicKey))
        ) {
          return apiError(400, "invalid_remote_request", "The host registration is invalid.");
        }
        const registered = yield* requestRemoteControlPlane().registerHost(user, {
          hostId: body.hostId,
          name: body.name,
          ownerMembershipId: body.ownerMembershipId,
          devicePublicKey: body.devicePublicKey,
          rotateCredential: body.rotateCredential,
          machineToken: body.machineToken,
        });
        // Sites this computer published before it was a server join the server's list. The host is
        // registered either way, so a failure here does not refuse the registration.
        yield* requestAdoptUnlinkedHostedSites(user.id, registered.hostId).pipe(
          Effect.catch(() => Effect.sync(() => console.warn("hosted sites: unlinked site adoption failed"))),
        );
        return json(registered, 201);
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const hostsHandlers = {
  GET: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        return json({ hosts: yield* requestRemoteControlPlane().listHosts(user.id) });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const hostHandlers = {
  // The owner removes the host from the account service. The host does not need to be online.
  DELETE: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestRemoteControlPlane().removeOwnedHost(user.id, params.hostId);
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

export const hostTicketHandlers = {
  POST: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.machineToken))
          return apiError(400, "invalid_remote_request", "The host credential is invalid.");
        // Only the host peer gateway asks for its home Signal. A released host sends neither field.
        if (
          (body.signalHome !== undefined && !isBoolean(body.signalHome)) ||
          (body.failedSignalUrl !== undefined && !isString(body.failedSignalUrl))
        )
          return apiError(400, "invalid_remote_request", "The Signal home request is invalid.");
        const signalHome = isBoolean(body.signalHome) ? body.signalHome : null;
        return json(
          yield* requestRemoteControlPlane().issueHostTicket(params.hostId, body.machineToken, {
            signalHome,
            failedSignalUrl: signalHome === true && isString(body.failedSignalUrl) ? body.failedSignalUrl : null,
          }),
        );
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

function decodedHandover(value: unknown): HostKeyHandover | null {
  try {
    return decodeHostKeyHandover(value);
  } catch {
    return null;
  }
}

export const hostKeyHandoverHandlers = {
  POST: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        const handover = decodedHandover(body.handover);
        if (!isString(body.machineToken) || !handover) {
          return apiError(400, "invalid_remote_request", "The host key handover is invalid.");
        }
        return json(
          yield* requestRemoteControlPlane().handOverHostKey(user, {
            hostId: params.hostId,
            machineToken: body.machineToken,
            handover,
          }),
        );
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

export const hostLogoHandlers = {
  GET: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const { logoKey } = yield* requestRemoteControlPlane().hostAsset(user.id, params.hostId);
        if (!logoKey || new URL(request.url).searchParams.get("v") !== logoKey) {
          return new Response("Not found", { status: 404 });
        }
        return (
          (yield* readHostLogo(requestAvatarBucket(), params.hostId, logoKey)) ??
          new Response("Not found", { status: 404 })
        );
      }),
      remoteControlPlaneErrorResponse,
    ),
  PUT: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestRemoteControlPlane().assertHostOwner(user.id, params.hostId);
        const upload = yield* readAvatarUpload(request);
        const requestedVersion = request.headers.get("OpenBot-Logo-Version");
        const version = requestedVersion && isUuidV4(requestedVersion) ? requestedVersion : crypto.randomUUID();
        const currentVersion = (yield* requestRemoteControlPlane().hostAsset(user.id, params.hostId)).logoKey;
        const bucket = requestAvatarBucket();
        const key = hostLogoObjectKey(params.hostId, version);
        yield* Effect.promise(() =>
          bucket.put(key, upload.bytes, {
            httpMetadata: { contentType: upload.mimeType, cacheControl: "private, max-age=31536000, immutable" },
          }),
        );
        yield* Effect.gen(function* () {
          const previous = yield* requestRemoteControlPlane().setHostLogo(user.id, params.hostId, version);
          if (previous && previous !== version) {
            const previousKey = hostLogoObjectKey(params.hostId, previous);
            yield* Effect.tryPromise(() => bucket.delete(previousKey)).pipe(Effect.ignore);
          }
        }).pipe(
          Effect.onError(() =>
            currentVersion !== version ? Effect.tryPromise(() => bucket.delete(key)).pipe(Effect.ignore) : Effect.void,
          ),
        );
        return Response.json({ logoKey: version }, { headers: { "Cache-Control": "no-store" } });
      }),
      (error) => {
        if (error instanceof AvatarUploadError) return apiError(error.status, error.code, error.message);
        return remoteControlPlaneErrorResponse(error);
      },
    ),
  DELETE: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const previous = yield* requestRemoteControlPlane().setHostLogo(user.id, params.hostId, null);
        if (previous) {
          const bucket = requestAvatarBucket();
          const previousKey = hostLogoObjectKey(params.hostId, previous);
          yield* Effect.tryPromise(() => bucket.delete(previousKey)).pipe(Effect.ignore);
        }
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

export const membersHandlers = {
  GET: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        return json({ members: yield* requestRemoteControlPlane().listMembers(user.id, params.hostId) });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

export const memberHandlers = {
  PATCH: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (body.role !== "admin" && body.role !== "member")
          return apiError(400, "invalid_remote_request", "The member role is invalid.");
        if (body.reactivate !== undefined && body.reactivate !== true)
          return apiError(400, "invalid_remote_request", "The member status is invalid.");
        yield* requestRemoteControlPlane().changeMembership(user.id, {
          hostId: params.hostId,
          membershipId: params.membershipId,
          role: body.role,
          reactivate: body.reactivate === true,
        });
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
  DELETE: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestRemoteControlPlane().changeMembership(user.id, {
          hostId: params.hostId,
          membershipId: params.membershipId,
          revoke: true,
        });
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string; membershipId: string }>;

export const hostInvitesHandlers = {
  GET: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        return json({ invites: yield* requestRemoteControlPlane().listInvites(user.id, params.hostId) });
      }),
      remoteControlPlaneErrorResponse,
    ),
  POST: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (
          (body.role !== "admin" && body.role !== "member") ||
          !(body.email === undefined || body.email === null || isString(body.email)) ||
          !(body.expiresInSeconds === undefined || isNumber(body.expiresInSeconds)) ||
          !(body.permanent === undefined || isBoolean(body.permanent))
        ) {
          return apiError(400, "invalid_remote_request", "The invitation is invalid.");
        }
        return json(
          yield* requestRemoteControlPlane().createInvite(user, {
            hostId: params.hostId,
            role: body.role,
            email: body.email,
            expiresInSeconds: body.expiresInSeconds,
            permanent: body.permanent,
          }),
          201,
        );
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ hostId: string }>;

export const invitePreviewHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.token)) return apiError(400, "invalid_remote_request", "The invitation token is invalid.");
        return json(yield* requestRemoteControlPlane().previewInvite(body.token));
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const inviteAcceptHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        const body = yield* readJsonObject(request);
        if (!isString(body.token)) return apiError(400, "invalid_remote_request", "The invitation token is invalid.");
        return json(yield* requestRemoteControlPlane().acceptInvite(user, body.token));
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const inviteHandlers = {
  DELETE: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const user = yield* requestUser(request);
        if (!user) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestRemoteControlPlane().revokeInvite(user.id, params.inviteId);
        return new Response(null, { status: 204 });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<{ inviteId: string }>;
