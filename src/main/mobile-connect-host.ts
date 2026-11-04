import type { MobileConnectAvailability } from "@openbot/contracts/ipc";
import type { MobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { CentralAuthManager } from "./central-auth-manager";
import { RemoteWorkflowError } from "./remote-service-effects";

interface MobileConnectHostDependencies<Operation extends keyof CentralAuthManager> {
  centralAuth: Pick<CentralAuthManager, Operation | "getState">;
  host: {
    configure(input: { serverName: string }): Effect.Effect<unknown, RemoteWorkflowError>;
    getStatus(): { configured: boolean };
    getMobileConnectHost(): MobileConnectHostBinding | null;
    isMobileConnectPublished(): boolean;
    publishForMobileConnect(): Effect.Effect<
      {
        serverId: string | null;
        phase: string;
        apiOnline: boolean;
        apiUrl: string | null;
        message: string | null;
      },
      RemoteWorkflowError
    >;
  };
}

/** Inspect the configured services only. Never publish a host or create a ticket here. */
export function mobileConnectAvailability(
  centralAuth: Pick<CentralAuthManager, "isEnabled" | "getState" | "resolveApiUrl">,
  host: { isMobileConnectPublished(): boolean },
): MobileConnectAvailability {
  if (!centralAuth.isEnabled()) return { state: "unconfigured", accountOrigin: null };
  const accountOrigin = new URL(centralAuth.resolveApiUrl("/")).origin;
  if (centralAuth.getState().status !== "signed_in") return { state: "signed-out", accountOrigin };
  return { state: host.isMobileConnectPublished() ? "ready" : "unpublished", accountOrigin };
}

export const createHostedMobileConnect = Effect.fn("MobileConnectHost.create")(function* ({
  centralAuth,
  host,
}: MobileConnectHostDependencies<"createMobileConnect">) {
  const accountId = yield* signedInAccount(centralAuth);
  const binding = yield* publishMobileConnectHost(host);
  yield* assertMobileAccount(centralAuth, host, accountId);
  const ticket = yield* centralAuth.createMobileConnect(binding);
  yield* assertMobileAccount(centralAuth, host, accountId);
  return ticket;
});

export const createHostedMobileConnectLink = Effect.fn("MobileConnectHost.createLink")(function* ({
  centralAuth,
  host,
}: MobileConnectHostDependencies<"createMobileConnectLink">) {
  const accountId = yield* signedInAccount(centralAuth);
  const binding = yield* publishMobileConnectHost(host);
  yield* assertMobileAccount(centralAuth, host, accountId);
  const link = yield* centralAuth.createMobileConnectLink(binding);
  yield* assertMobileAccount(centralAuth, host, accountId);
  return link;
});

/** Starts the host, so the phone that uses the code can reach it, and returns its identity. */
const publishMobileConnectHost = Effect.fn("MobileConnectHost.publish")(function* (
  host: MobileConnectHostDependencies<never>["host"],
) {
  if (!host.getStatus().configured) yield* host.configure({ serverName: "OpenBot" });
  const status = yield* host.publishForMobileConnect();
  if (status.phase !== "online" || !status.apiOnline || !host.isMobileConnectPublished()) {
    return yield* new RemoteWorkflowError({
      cause: new Error(status.message ?? sourceText("error.host.mobileConnectPublishFailed")),
    });
  }
  const binding = host.getMobileConnectHost();
  if (!binding || binding.hostId !== status.serverId)
    return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.mobileConnectHostChanged")) });
  return binding;
});

const signedInAccount = Effect.fn("MobileConnectHost.signedInAccount")(function* (
  centralAuth: Pick<CentralAuthManager, "getState">,
) {
  const state = centralAuth.getState();
  if (state.status !== "signed_in")
    return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.auth.signInFirst")) });
  return state.user.id;
});

const assertMobileAccount = Effect.fn("MobileConnectHost.assertAccount")(function* (
  centralAuth: Pick<CentralAuthManager, "getState">,
  host: { isMobileConnectPublished(): boolean },
  accountId: string,
) {
  if ((yield* signedInAccount(centralAuth)) !== accountId || !host.isMobileConnectPublished())
    return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.accountChangedDuringUpdate")) });
});
