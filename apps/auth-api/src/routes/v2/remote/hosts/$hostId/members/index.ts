import { createFileRoute } from "@tanstack/solid-router";
import { membersHandlers } from "../../../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/members/")({
  server: { handlers: membersHandlers },
});
