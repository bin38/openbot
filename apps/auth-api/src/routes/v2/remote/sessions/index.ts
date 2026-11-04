import { createFileRoute } from "@tanstack/solid-router";
import { sessionsHandlers } from "../../../../server/native-session-handlers";

export const Route = createFileRoute("/v2/remote/sessions/")({
  server: { handlers: sessionsHandlers },
});
