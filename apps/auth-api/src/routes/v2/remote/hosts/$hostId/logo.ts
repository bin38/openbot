import { createFileRoute } from "@tanstack/solid-router";
import { hostLogoHandlers } from "../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/logo")({
  server: { handlers: hostLogoHandlers },
});
