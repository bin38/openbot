import { EmailMessage } from "cloudflare:email";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { normalizeEmailAddress } from "@openbot/contracts/validation";
import { Effect } from "effect";
import { EmailDeliveryError } from "./email-delivery-error";
import { type RenderedEmail, renderSignInCodeEmail, renderTeamInviteEmail } from "./email-templates";
import { RATE_LIMITED_DELIVERY_ERROR } from "./smtp-email-delivery";
import type { EmailCodeDelivery, TeamInviteEmailDelivery, WorkerBindings } from "./types";

type CloudflareEmailBindings = Pick<WorkerBindings, "EMAIL" | "EMAIL_FROM" | "AUTH_ALLOWED_EMAILS">;

/** No wildcard and no implicit owner. The sending binding also restricts verified destinations. */
export function cloudflareEmailConfiguration(bindings: CloudflareEmailBindings) {
  const from = normalizeEmailAddress(bindings.EMAIL_FROM ?? "");
  const entries = (bindings.AUTH_ALLOWED_EMAILS ?? "").split(",").map((value) => value.trim());
  const recipients = entries.map(normalizeEmailAddress);
  if (!bindings.EMAIL || !from || entries.length === 0 || recipients.some((value) => value === null)) return null;
  const allowed = new Set(recipients.filter((value) => value !== null));
  return allowed.size > 0 ? { binding: bindings.EMAIL, from, allowed } : null;
}

export function createCloudflareEmailCodeDelivery(bindings: CloudflareEmailBindings): EmailCodeDelivery | null {
  const config = cloudflareEmailConfiguration(bindings);
  if (!config) return null;
  return {
    send: (message) =>
      sendMessage(
        config,
        message.email,
        renderSignInCodeEmail({
          code: message.code,
          expiresInMinutes: Math.max(1, Math.ceil((message.expiresAt - Date.now()) / 60_000)),
        }),
      ),
  };
}

export function createCloudflareInviteEmailDelivery(bindings: CloudflareEmailBindings): TeamInviteEmailDelivery | null {
  const config = cloudflareEmailConfiguration(bindings);
  if (!config) return null;
  return { send: (message) => sendMessage(config, message.email, renderTeamInviteEmail(message)) };
}

const sendMessage = Effect.fn("CloudflareEmail.send")(function* (
  config: NonNullable<ReturnType<typeof cloudflareEmailConfiguration>>,
  requestedEmail: string,
  content: RenderedEmail,
) {
  const to = normalizeEmailAddress(requestedEmail);
  if (!to || !config.allowed.has(to)) {
    return yield* new EmailDeliveryError({ message: "email_delivery_recipient_not_allowed" });
  }
  // Keep the requested identity as the actual recipient. A fixed fallback inbox would authenticate
  // another person's email address with a code sent to the operator.
  const boundary = `openbot-${crypto.randomUUID()}`;
  const raw = [
    `From: ${config.from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${base64(content.subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${config.from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64(content.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64(content.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  yield* Effect.tryPromise({
    try: () => config.binding.send(new EmailMessage(config.from, to, raw)),
    catch: (error) =>
      new EmailDeliveryError({
        message:
          isDynamicRecord(error) && error.code === "E_RATE_LIMIT_EXCEEDED"
            ? RATE_LIMITED_DELIVERY_ERROR
            : "email_delivery_unknown",
      }),
  });
});

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/.{76}(?=.)/gu, "$&\r\n");
}
