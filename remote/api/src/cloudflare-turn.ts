import { Effect, Schema } from "effect";
import { z } from "zod";
import type { CloudflareTurnConfig } from "./config";
import type { IceServer } from "./protocol";

export class CloudflareTurnError extends Schema.TaggedError<CloudflareTurnError>()("CloudflareTurnError", {
  message: Schema.String,
}) {}

export type TurnCredentialFetch = (url: string, init: RequestInit) => Promise<Response>;

const iceUrl = z
  .string()
  .max(256)
  .regex(/^(?:stun:stun|turns?:turn)\.cloudflare\.com:(?:3478|5349|443|80)(?:\?transport=(?:udp|tcp))?$/u);
const iceServerSchema = z.object({
  urls: z.union([iceUrl, z.array(iceUrl).min(1).max(16)]),
  username: z.string().min(1).max(1_024).optional(),
  credential: z.string().min(1).max(1_024).optional(),
});
const responseSchema = z.object({ iceServers: z.array(iceServerSchema).min(1).max(8) });
const unavailable = () => new CloudflareTurnError({ message: "TURN credentials are unavailable." });

/** The long-lived API token stays here. Only bounded, short-lived ICE credentials leave this adapter. */
export const requestCloudflareTurnCredentials = Effect.fn("CloudflareTurn.credentials")(
  (config: CloudflareTurnConfig, ttl: number, request: TurnCredentialFetch = fetch) =>
    Effect.tryPromise({
      try: async (signal): Promise<IceServer[]> => {
        if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 172_800) throw unavailable();
        const response = await request(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ttl }),
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (response.status !== 201 || !response.body) {
          await response.body?.cancel();
          throw unavailable();
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 32_768) throw unavailable();
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const { iceServers } = responseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        let hasRelay = false;
        for (const server of iceServers) {
          const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
          if (urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"))) {
            if (!server.username || !server.credential) throw unavailable();
            hasRelay = true;
          }
        }
        if (!hasRelay) throw unavailable();
        return iceServers;
      },
      // Cloudflare error bodies, URLs, headers and decoder errors can contain credentials.
      catch: unavailable,
    }),
);
