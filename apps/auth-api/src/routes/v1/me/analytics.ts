import { createFileRoute } from "@tanstack/solid-router";
import { analyticsHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/me/analytics")({
  server: { handlers: analyticsHandlers },
});
