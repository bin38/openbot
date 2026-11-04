import { createFileRoute } from "@tanstack/solid-router";
import { hostInvitesHandlers } from "../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/invites")({
  server: { handlers: hostInvitesHandlers },
});
