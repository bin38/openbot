import type { NativeApiHandlers, NativeApiMethod } from "./native-api-types";
import {
  analyticsHandlers,
  avatarHandlers,
  avatarReadHandlers,
  emailStartHandlers,
  emailVerifyHandlers,
  inviteEmailHandlers,
  logoutHandlers,
  meHandlers,
  profileHandlers,
  teamRedeemHandlers,
  teamTicketHandlers,
} from "./native-auth-handlers";
import {
  hostHandlers,
  hostInvitesHandlers,
  hostKeyHandoverHandlers,
  hostLogoHandlers,
  hostRegisterHandlers,
  hostsHandlers,
  hostTicketHandlers,
  inviteAcceptHandlers,
  inviteHandlers,
  invitePreviewHandlers,
  memberHandlers,
  membersHandlers,
} from "./native-host-handlers";
import {
  mobileDeviceHandlers,
  mobileDevicesHandlers,
  mobileEmailVerifyHandlers,
  mobileLinkHandlers,
  mobileRedeemHandlers,
  mobileSessionHandlers,
  mobileTicketHandlers,
} from "./native-mobile-handlers";
import { apiError, authErrorResponse } from "./native-request-auth";
import {
  jwksHandlers,
  resumeValidateHandlers,
  sessionEndHandlers,
  sessionsHandlers,
  sessionTicketHandlers,
} from "./native-session-handlers";

/** Only these existing native API handlers are reachable from the independent Worker. */
const routes = [
  nativeRoute(/^\/v1\/auth\/email\/start\/?$/u, emailStartHandlers, () => ({})),
  nativeRoute(/^\/v1\/auth\/email\/verify\/?$/u, emailVerifyHandlers, () => ({})),
  nativeRoute(/^\/v1\/auth\/logout\/?$/u, logoutHandlers, () => ({})),
  nativeRoute(/^\/v1\/me\/?$/u, meHandlers, () => ({})),
  nativeRoute(/^\/v1\/me\/profile\/?$/u, profileHandlers, () => ({})),
  nativeRoute(/^\/v1\/me\/analytics\/?$/u, analyticsHandlers, () => ({})),
  nativeRoute(/^\/v1\/me\/avatar\/?$/u, avatarHandlers, () => ({})),
  nativeRoute(/^\/v1\/avatars\/([^/]+)\/?$/u, avatarReadHandlers, (match) => ({ userId: parameter(match, 1) })),
  nativeRoute(/^\/v1\/team-auth\/ticket\/?$/u, teamTicketHandlers, () => ({})),
  nativeRoute(/^\/v1\/team-auth\/redeem\/?$/u, teamRedeemHandlers, () => ({})),
  nativeRoute(/^\/v1\/team-invitations\/email\/?$/u, inviteEmailHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/ticket\/?$/u, mobileTicketHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/link\/?$/u, mobileLinkHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/redeem\/?$/u, mobileRedeemHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/session\/?$/u, mobileSessionHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/devices\/?$/u, mobileDevicesHandlers, () => ({})),
  nativeRoute(/^\/v1\/mobile-auth\/devices\/([^/]+)\/?$/u, mobileDeviceHandlers, (match) => ({
    sessionId: parameter(match, 1),
  })),
  nativeRoute(/^\/v1\/mobile-auth\/email\/verify\/?$/u, mobileEmailVerifyHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/hosts\/register\/?$/u, hostRegisterHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/hosts\/?$/u, hostsHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/?$/u, hostHandlers, (match) => ({ hostId: parameter(match, 1) })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/ticket\/?$/u, hostTicketHandlers, (match) => ({
    hostId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/key-handover\/?$/u, hostKeyHandoverHandlers, (match) => ({
    hostId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/logo\/?$/u, hostLogoHandlers, (match) => ({
    hostId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/members\/?$/u, membersHandlers, (match) => ({
    hostId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/members\/([^/]+)\/?$/u, memberHandlers, (match) => ({
    hostId: parameter(match, 1),
    membershipId: parameter(match, 2),
  })),
  nativeRoute(/^\/v2\/remote\/hosts\/([^/]+)\/invites\/?$/u, hostInvitesHandlers, (match) => ({
    hostId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/invites\/preview\/?$/u, invitePreviewHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/invites\/accept\/?$/u, inviteAcceptHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/invites\/([^/]+)\/?$/u, inviteHandlers, (match) => ({ inviteId: parameter(match, 1) })),
  nativeRoute(/^\/v2\/remote\/sessions\/?$/u, sessionsHandlers, () => ({})),
  nativeRoute(/^\/v2\/remote\/sessions\/([^/]+)\/ticket\/?$/u, sessionTicketHandlers, (match) => ({
    sessionId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/sessions\/([^/]+)\/end\/?$/u, sessionEndHandlers, (match) => ({
    sessionId: parameter(match, 1),
  })),
  nativeRoute(/^\/v2\/remote\/resume\/validate\/?$/u, resumeValidateHandlers, () => ({})),
  nativeRoute(/^\/[.]well-known\/jwks[.]json\/?$/u, jwksHandlers, () => ({})),
];

/** No page router, cookie login, marketplace, billing, or hosted-server handler is mounted here. */
export async function handleIndependentAccountApi(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    for (const route of routes) {
      const response = route(request, path);
      if (response) return await response;
    }
    return apiError(404, "route_not_found", "This account API route is not available.");
  } catch (error) {
    if (error instanceof URIError) return apiError(400, "invalid_remote_request", "The request path is invalid.");
    return authErrorResponse(error);
  }
}

function nativeRoute<Params>(
  pattern: RegExp,
  handlers: NativeApiHandlers<Params>,
  parameters: (match: RegExpMatchArray) => Params,
) {
  return (request: Request, path: string): Response | Promise<Response> | null => {
    const match = pattern.exec(path);
    if (!match) return null;
    const method = request.method === "HEAD" ? "GET" : request.method;
    const handler = isNativeMethod(method) ? handlers[method] : undefined;
    if (!handler) {
      const response = apiError(405, "method_not_allowed", "This method is not supported.");
      response.headers.set("Allow", Object.keys(handlers).join(", "));
      return response;
    }
    const result = handler({ request, params: parameters(match) });
    return request.method === "HEAD"
      ? Promise.resolve(result).then(
          (response) => new Response(null, { status: response.status, headers: response.headers }),
        )
      : result;
  };
}

function isNativeMethod(value: string): value is NativeApiMethod {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

function parameter(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (!value) throw new URIError("The path parameter is missing.");
  return decodeURIComponent(value);
}
