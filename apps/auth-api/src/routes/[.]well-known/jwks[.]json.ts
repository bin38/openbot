import { createFileRoute } from "@tanstack/solid-router";
import { jwksHandlers } from "../../server/native-session-handlers";

export const Route = createFileRoute("/.well-known/jwks.json")({
  server: { handlers: jwksHandlers },
});
