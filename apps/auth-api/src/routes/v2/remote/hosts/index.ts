import { createFileRoute } from "@tanstack/solid-router";
import { hostsHandlers } from "../../../../server/native-host-handlers";

export const Route = createFileRoute("/v2/remote/hosts/")({
  server: { handlers: hostsHandlers },
});
