import { createFileRoute } from "@tanstack/solid-router";
import { inviteAcceptHandlers } from "../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/invites/accept")({
  server: { handlers: inviteAcceptHandlers },
});
