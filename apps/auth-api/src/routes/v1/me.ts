import { createFileRoute } from "@tanstack/solid-router";
import { meHandlers } from "../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/me")({
  server: { handlers: meHandlers },
});
