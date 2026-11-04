import { createFileRoute } from "@tanstack/solid-router";
import { mobileTicketHandlers } from "../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/ticket")({
  server: { handlers: mobileTicketHandlers },
});
