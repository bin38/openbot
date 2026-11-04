import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { pruneExpiredAuthData } from "./server/auth-data-retention";
import { cloudflareEmailConfiguration } from "./server/cloudflare-email-delivery";
import { runApiEffect } from "./server/effect-runtime";
import { handleIndependentAccountApi } from "./server/independent-account-api";
import { isOriginalServiceUrl } from "./server/independent-edition";
import { apiError, json } from "./server/native-request-auth";
import { deliverPendingRemoteAuthEvents } from "./server/remote-control-plane";
import { type AccountWorkerBindings, requireAccountWorkerBindings } from "./server/types";

/** The native account API only. Chat and file traffic stays on the host's encrypted WebRTC channel. */
export default {
  async fetch(request: Request, env: AccountWorkerBindings, context: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/$/u, "");
    if (path === "/health/live" && request.method === "GET") return json({ service: "openbot-auth-api", status: "ok" });
    if (!configured(env)) return apiError(503, "service_not_ready", sourceText("error.auth.serviceUnavailable"));
    if (path === "/health/ready" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT 1 AS ready").first();
        return json({ service: "openbot-auth-api", status: "ready" });
      } catch {
        return apiError(503, "service_not_ready", sourceText("error.auth.serviceUnavailable"));
      }
    }
    const response = handleIndependentAccountApi(request);
    // A client can disconnect while the one-time code is being sent. Keep the existing durable
    // challenge delivery workflow alive so a retry observes its real result.
    if (path === "/v1/auth/email/start" && request.method === "POST") {
      context.waitUntil(
        response.then(
          () => undefined,
          () => undefined,
        ),
      );
    }
    return response;
  },
  async scheduled(controller: ScheduledController, env: AccountWorkerBindings): Promise<void> {
    if (!configured(env)) return;
    await runApiEffect(deliverPendingRemoteAuthEvents(env, controller.scheduledTime));
    const time = new Date(controller.scheduledTime);
    if (time.getUTCHours() === 3 && time.getUTCMinutes() === 0) {
      await runApiEffect(pruneExpiredAuthData(env.DB, controller.scheduledTime).pipe(Effect.asVoid));
    }
  },
} satisfies ExportedHandler<AccountWorkerBindings>;

function configured(env: AccountWorkerBindings): boolean {
  try {
    requireAccountWorkerBindings(env);
    if (env.AUTH_EXPOSE_DEVELOPMENT_CODE === "true" || !cloudflareEmailConfiguration(env)) return false;
    if (
      !env.REMOTE_TICKET_PRIVATE_JWK ||
      !env.REMOTE_TICKET_PUBLIC_JWKS ||
      !env.REMOTE_TICKET_KEY_ID ||
      !env.REMOTE_AUTH_WEBHOOK_SECRET
    )
      return false;
    const signal = new URL(env.REMOTE_SIGNAL_URL ?? "");
    const webhook = new URL(env.REMOTE_AUTH_WEBHOOK_URL ?? "");
    return (
      signal.protocol === "wss:" &&
      webhook.protocol === "https:" &&
      !signal.username &&
      !signal.password &&
      !webhook.username &&
      !webhook.password &&
      !isOriginalServiceUrl(signal.href) &&
      !isOriginalServiceUrl(webhook.href)
    );
  } catch {
    return false;
  }
}
