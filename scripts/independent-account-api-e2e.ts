// Keep Cloudflare bindings in the account-service project.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("independent-account-api-e2e");
const child = spawn("bun", ["apps/auth-api/scripts/independent-account-api-e2e.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: "inherit",
});
child.on("error", () => {
  logger.error("The account service check could not start.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
