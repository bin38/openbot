import { createFileRoute } from "@tanstack/solid-router";
import { emailStartHandlers } from "../../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/auth/email/start")({
  server: { handlers: emailStartHandlers },
});
