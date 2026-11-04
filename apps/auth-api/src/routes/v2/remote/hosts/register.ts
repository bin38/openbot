import { createFileRoute } from "@tanstack/solid-router";
import { hostRegisterHandlers } from "../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/register")({
  server: { handlers: hostRegisterHandlers },
});
