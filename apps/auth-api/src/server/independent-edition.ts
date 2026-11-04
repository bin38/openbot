import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { sourceText } from "@openbot/i18n/source";

const COMMERCIAL_API_PREFIXES = [
  "/v1/me/billing",
  "/v1/me/license",
  "/v1/stripe",
  "/v1/sites",
  "/v2/hosting",
  "/health/hosting",
  "/billing",
] as const;

/** Reject the original sales API before the router constructs a service or reads its bindings. */
export function independentServiceResponse(request: Request): Response | null {
  if (!INDEPENDENT_EDITION) return null;
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/api\/browser(?=\/)/u, "");
  } catch {
    return null;
  }
  if (!COMMERCIAL_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return Response.json(
    { error: { code: "service_unavailable", message: sourceText("error.auth.independentServiceUnavailable") } },
    { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

/** Old deployment settings must not send account events or connection tickets to the original service. */
export function isOriginalServiceUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
    return ["openbot.run", "openbot.site"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
