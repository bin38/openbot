import { createFileRoute } from "@tanstack/solid-router";
import { mobileRedeemHandlers } from "../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/redeem")({
  server: { handlers: mobileRedeemHandlers },
});
