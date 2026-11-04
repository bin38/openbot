import { createFileRoute } from "@tanstack/solid-router";
import { avatarReadHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/avatars/$userId")({
  server: { handlers: avatarReadHandlers },
});
