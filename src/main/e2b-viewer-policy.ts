import type { E2bViewerBounds } from "@openbot/contracts/ipc";

/** Only the main renderer may place a native cloud view over the main window. */
export function requireE2bViewerSender(senderId: number, mainRendererId: number | null): void {
  if (senderId !== mainRendererId) throw new Error("Cloud viewer controls require the main renderer.");
}

/** Convert CSS pixels to native content coordinates and clip to the owning window. */
export function e2bViewerRectangle(
  bounds: E2bViewerBounds | null,
  zoom: number,
  width: number,
  height: number,
): E2bViewerBounds | null {
  if (!bounds || !Number.isFinite(zoom) || zoom <= 0) return null;
  const x = Math.max(0, Math.floor(bounds.x * zoom));
  const y = Math.max(0, Math.floor(bounds.y * zoom));
  const right = Math.min(width, Math.ceil((bounds.x + bounds.width) * zoom));
  const bottom = Math.min(height, Math.ceil((bounds.y + bounds.height) * zoom));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Only the authenticated noVNC page returned by the official cloud desktop is a viewer. */
export function e2bViewerOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".e2b.app") ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/vnc.html" ||
    !url.searchParams.get("password")
  ) {
    throw new Error("Invalid cloud computer viewer URL.");
  }
  return url.origin;
}

/** External resources cannot receive the viewer URL or its password through a referrer. */
export function isE2bViewerResource(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    const expected = new URL(origin);
    return (
      url.hostname === expected.hostname &&
      url.port === expected.port &&
      (url.protocol === "https:" || url.protocol === "wss:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

const TRAFFIC_HEADER = "e2b-traffic-access-token";

/** Add the private-port token only to this viewer's HTTPS and WebSocket origin. */
export function e2bViewerHeaders(
  value: string,
  origin: string,
  trafficAccessToken: string | undefined,
  headers: Record<string, string>,
): Record<string, string> {
  if (trafficAccessToken && (trafficAccessToken.length > 8_192 || /[\s\p{Cc}]/u.test(trafficAccessToken))) {
    throw new Error("Invalid cloud viewer access token.");
  }
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === TRAFFIC_HEADER) delete result[key];
  }
  if (!trafficAccessToken || !isE2bViewerResource(value, origin)) return result;
  const protocol = new URL(value).protocol;
  if (protocol === "https:" || protocol === "wss:") result[TRAFFIC_HEADER] = trafficAccessToken;
  return result;
}
