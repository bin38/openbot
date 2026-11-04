import { createFileRoute } from "@tanstack/solid-router";
import { mobileSessionHandlers } from "../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/session")({
  server: { handlers: mobileSessionHandlers },
});
