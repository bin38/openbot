import { createFileRoute } from "@tanstack/solid-router";
import { inviteEmailHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/team-invitations/email")({
  server: { handlers: inviteEmailHandlers },
});
