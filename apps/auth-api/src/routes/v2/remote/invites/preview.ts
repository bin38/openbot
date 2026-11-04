import { createFileRoute } from "@tanstack/solid-router";
import { invitePreviewHandlers } from "../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/invites/preview")({
  server: { handlers: invitePreviewHandlers },
});
