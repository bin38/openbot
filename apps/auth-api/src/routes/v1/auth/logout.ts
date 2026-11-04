import { createFileRoute } from "@tanstack/solid-router";
import { logoutHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/auth/logout")({
  server: { handlers: logoutHandlers },
});
