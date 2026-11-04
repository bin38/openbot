import { createFileRoute } from "@tanstack/solid-router";
import { sessionTicketHandlers } from "../../../../../server/native-session-handlers";

export const Route = createFileRoute("/v2/remote/sessions/$sessionId/ticket")({
  server: { handlers: sessionTicketHandlers },
});
