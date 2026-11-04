import { createFileRoute } from "@tanstack/solid-router";
import { hostTicketHandlers } from "../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/ticket")({
  server: { handlers: hostTicketHandlers },
});
