import { createFileRoute } from "@tanstack/solid-router";
import { mobileDeviceHandlers } from "../../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/devices/$sessionId")({
  server: { handlers: mobileDeviceHandlers },
});
