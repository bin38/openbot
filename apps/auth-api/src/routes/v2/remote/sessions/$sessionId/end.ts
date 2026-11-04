import { createFileRoute } from "@tanstack/solid-router";
import { sessionEndHandlers } from "../../../../../server/native-session-handlers";

export const Route = createFileRoute("/v2/remote/sessions/$sessionId/end")({
  server: { handlers: sessionEndHandlers },
});
