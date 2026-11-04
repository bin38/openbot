import { createFileRoute } from "@tanstack/solid-router";
import { resumeValidateHandlers } from "../../../../server/native-session-handlers";

export const Route = createFileRoute("/v2/remote/resume/validate")({
  server: { handlers: resumeValidateHandlers },
});
