import { createFileRoute } from "@tanstack/solid-router";
import { teamTicketHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/team-auth/ticket")({
  server: { handlers: teamTicketHandlers },
});
