import { createFileRoute } from "@tanstack/solid-router";
import { emailVerifyHandlers } from "../../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/auth/email/verify")({
  server: { handlers: emailVerifyHandlers },
});
