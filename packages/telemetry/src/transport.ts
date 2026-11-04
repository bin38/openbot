import { type ReportTransport, telemetryIO } from "./queue";

type TelemetryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Telemetry has no vendor default. Only an explicit operator endpoint can receive a report. */
export function telemetryEndpoint(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname === "openbot.run" ||
      url.hostname.endsWith(".openbot.run") ||
      url.hostname === "openbot.site" ||
      url.hostname.endsWith(".openbot.site")
    )
      return null;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function openPanelTransport(options: {
  clientId: string;
  clientSecret?: string;
  origin?: string;
  endpoint?: string;
  fetch?: TelemetryFetch;
}): ReportTransport {
  const send = options.fetch ?? globalThis.fetch;
  const endpoint = telemetryEndpoint(options.endpoint);
  return (report, signal) =>
    telemetryIO(async () => {
      if (!endpoint) return false;
      const response = await send(endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          "content-type": "application/json",
          "openpanel-client-id": options.clientId,
          ...(options.clientSecret ? { "openpanel-client-secret": options.clientSecret } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        },
        body: JSON.stringify({
          type: "track",
          payload: {
            name: report.name,
            ...(report.profileId ? { profileId: report.profileId } : {}),
            properties: {
              ...report.properties,
              report_id: report.id,
              __timestamp: report.timestamp,
              surface: report.surface,
              environment: "production",
              app_version: report.app_version,
              platform: report.platform,
              event_schema_version: report.event_schema_version,
              __path: "",
              __referrer: "",
            },
          },
        }),
      });
      await response.body?.cancel();
      return response.status === 200 || response.status === 202;
    });
}
