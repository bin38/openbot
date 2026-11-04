import { isMobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { runApiResponse } from "./effect-runtime";
import { readJsonObject } from "./json-body";
import type { NativeApiHandlers } from "./native-api-types";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  remoteControlPlaneErrorResponse,
  requestAuthService,
  requestRemoteControlPlane,
} from "./native-request-auth";
import { requestSourceIp } from "./source-ip";

// Shared by the original native API routes and the independent Worker.
export const mobileTicketHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const service = requestAuthService();
        const user = yield* service.authenticateDesktopSession(token);
        if (!user) return apiError(401, "unauthorized", "A desktop session is required.");
        const body = yield* readJsonObject(request);
        if (!isMobileConnectHostBinding(body.host))
          return apiError(
            400,
            "invalid_mobile_host",
            "Update the desktop app to create a host-bound Mobile Connect code.",
          );
        yield* requestRemoteControlPlane().validateMobileConnectHost(user.id, body.host);
        return json(yield* service.issueMobileAuthTicket(token, requestSourceIp(request), body.host));
      }),
      remoteControlPlaneErrorResponse,
    ),
  DELETE: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const hostId = new URL(request.url).searchParams.get("host") ?? "";
        yield* requestAuthService().cancelMobileAuthTickets(token, hostId);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const mobileLinkHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const service = requestAuthService();
        const user = yield* service.authenticateDesktopSession(token);
        if (!user) return apiError(401, "unauthorized", "A desktop session is required.");
        const body = yield* readJsonObject(request);
        if (!isMobileConnectHostBinding(body.host))
          return apiError(
            400,
            "invalid_mobile_host",
            "Update the desktop app to create a host-bound Mobile Connect code.",
          );
        yield* requestRemoteControlPlane().validateMobileConnectHost(user.id, body.host);
        return json(yield* service.createMobileConnectLink(token, requestSourceIp(request), body.host));
      }),
      remoteControlPlaneErrorResponse,
    ),
  DELETE: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const hostId = new URL(request.url).searchParams.get("host") ?? "";
        yield* requestAuthService().revokeMobileConnectLink(token, hostId);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }),
      remoteControlPlaneErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const mobileRedeemHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (
          !isString(body.ticket) ||
          !isString(body.deviceId) ||
          !isString(body.deviceName) ||
          (body.platform !== "ios" && body.platform !== "android" && body.platform !== "unknown")
        ) {
          return apiError(400, "invalid_mobile_ticket", "The Mobile Connect code is invalid.");
        }
        const session = yield* requestAuthService().redeemMobileAuthTicket(
          body.ticket,
          { id: body.deviceId, name: body.deviceName, platform: body.platform },
          requestSourceIp(request),
        );
        return session
          ? json(session)
          : apiError(401, "invalid_mobile_ticket", "The Mobile Connect code is invalid or expired.");
      }),
      (error) => {
        if (error instanceof SyntaxError) {
          return apiError(400, "invalid_json", "The request body is invalid.");
        }
        return authErrorResponse(error);
      },
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const mobileSessionHandlers = {
  GET: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const user = yield* requestAuthService().authenticateMobileSession(token);
        return user ? json(user) : apiError(401, "unauthorized", "The mobile session is invalid.");
      }),
      authErrorResponse,
    ),
  DELETE: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        yield* requestAuthService().logoutMobileSession(token);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const mobileDevicesHandlers = {
  GET: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        const query = new URL(request.url).searchParams;
        // Additive opt-in: existing clients continue receiving only mobile devices.
        if (query.get("includeDesktop") === "true") {
          return json({ sessions: yield* requestAuthService().listAccountSessions(token) });
        }
        // Additive opt-in: with `host`, only the phones that can open that host. Without it, every phone.
        return json({ devices: yield* requestAuthService().listMobileAuthDevices(token, query.get("host")) });
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<Record<never, never>>;

export const mobileDeviceHandlers = {
  DELETE: ({ request, params }) =>
    runApiResponse(
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (!token) return apiError(401, "unauthorized", "Sign in is required.");
        if (new URL(request.url).searchParams.get("includeDesktop") === "true") {
          yield* requestAuthService().revokeAccountSession(token, params.sessionId);
        } else yield* requestAuthService().revokeMobileAuthDevice(token, params.sessionId);
        return new Response(null, { status: 204 });
      }),
      authErrorResponse,
    ),
} satisfies NativeApiHandlers<{ sessionId: string }>;

export const mobileEmailVerifyHandlers = {
  POST: ({ request }) =>
    runApiResponse(
      Effect.gen(function* () {
        const body = yield* readJsonObject(request);
        if (!isString(body.challengeId) || !isString(body.code)) {
          return apiError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
        }
        if (
          !isString(body.deviceId) ||
          !isString(body.deviceName) ||
          (body.platform !== "ios" && body.platform !== "android" && body.platform !== "unknown")
        ) {
          return apiError(400, "invalid_mobile_device", "The mobile device is invalid.");
        }
        return json(
          yield* requestAuthService().verifyMobileEmailCode({
            challengeId: body.challengeId,
            code: body.code,
            sourceIp: requestSourceIp(request),
            device: { id: body.deviceId, name: body.deviceName, platform: body.platform },
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
