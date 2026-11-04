import { createFileRoute } from "@tanstack/solid-router";
import { hostKeyHandoverHandlers } from "../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/key-handover")({
  server: { handlers: hostKeyHandoverHandlers },
});
