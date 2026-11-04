import { createFileRoute } from "@tanstack/solid-router";
import { teamRedeemHandlers } from "../../../server/native-auth-handlers";

export const Route = createFileRoute("/v1/team-auth/redeem")({
  server: { handlers: teamRedeemHandlers },
});
