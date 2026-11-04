import { createFileRoute } from "@tanstack/solid-router";
import { avatarHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/me/avatar")({
  server: { handlers: avatarHandlers },
});
