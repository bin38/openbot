import { createFileRoute } from "@tanstack/solid-router";
import { profileHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/me/profile")({
  server: { handlers: profileHandlers },
});
