import { createFileRoute } from "@tanstack/solid-router";
import { mobileEmailVerifyHandlers } from "../../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/email/verify")({
  server: { handlers: mobileEmailVerifyHandlers },
});
