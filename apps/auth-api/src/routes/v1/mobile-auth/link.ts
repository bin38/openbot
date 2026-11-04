import { createFileRoute } from "@tanstack/solid-router";
import { mobileLinkHandlers } from "../../../server/native-mobile-handlers";

export const Route = createFileRoute("/v1/mobile-auth/link")({
  server: { handlers: mobileLinkHandlers },
});
