import { createFileRoute } from "@tanstack/solid-router";
import { inviteHandlers } from "../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/invites/$inviteId")({
  server: { handlers: inviteHandlers },
});
