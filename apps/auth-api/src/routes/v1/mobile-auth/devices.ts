import { createFileRoute } from "@tanstack/solid-router";
import { mobileDevicesHandlers } from "../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/devices")({
  server: { handlers: mobileDevicesHandlers },
});
