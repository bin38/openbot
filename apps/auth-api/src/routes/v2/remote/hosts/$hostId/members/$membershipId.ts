import { createFileRoute } from "@tanstack/solid-router";
import { memberHandlers } from "../../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/members/$membershipId")({
  server: { handlers: memberHandlers },
});
