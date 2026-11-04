import { isMobileConnectDevelopmentHost } from "@openbot/contracts/mobile-connect";

interface SignalEnvironment extends Record<string, string | undefined> {
  OPENBOT_SELF_HOSTED_API_URL?: string;
  OPENBOT_SELF_HOSTED_SIGNAL_URL?: string;
  OPENBOT_AUTH_API_URL?: string;
  OPENBOT_REMOTE_SIGNAL_URL?: string;
}

/** Independent services never fall back to the original account configuration. */
export function configuredSelfHostedSignalOrigin(environment: SignalEnvironment, independent: boolean): string | null {
  return independent
    ? readSelfHostedSignalOrigin(environment.OPENBOT_SELF_HOSTED_API_URL, environment.OPENBOT_SELF_HOSTED_SIGNAL_URL, {
        account: "OPENBOT_SELF_HOSTED_API_URL",
        signal: "OPENBOT_SELF_HOSTED_SIGNAL_URL",
      })
    : readSelfHostedSignalOrigin(environment.OPENBOT_AUTH_API_URL, environment.OPENBOT_REMOTE_SIGNAL_URL);
}

export function buildContentSecurityPolicy(
  packaged: boolean,
  developmentSignalUrl?: string,
  selfHostedSignalOrigin?: string | null,
): string {
  const selfHostedSignalSource = selfHostedSignalOrigin ? ` ${selfHostedSignalOrigin}` : "";
  const developmentSources = packaged
    ? ""
    : ` http://localhost:* ws://localhost:*${developmentSignalSource(developmentSignalUrl)}`;
  const developmentImageSources = packaged ? "" : " http://127.0.0.1:* http://localhost:*";

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: openbot-attachment: openbot-remote-attachment: openbot-avatar: openbot-remote-avatar: openbot-server-logo: openbot-remote-server-logo: https:${developmentImageSources}`,
    "font-src 'self' data:",
    // The lightbox plays a recording from the attachment scheme, and the preview panel plays one
    // from an object URL of the bytes that the main process sent. Neither matches `default-src`.
    "media-src 'self' blob: openbot-attachment: openbot-remote-attachment:",
    `connect-src 'self' openbot-attachment: openbot-remote-attachment: ws://127.0.0.1:*${selfHostedSignalSource}${developmentSources}`,
    "object-src 'none'",
    // The remote desktop viewer uses a loopback proxy in packaged apps too.
    "frame-src 'self' openbot-attachment: openbot-remote-attachment: openbot-visual: openbot-remote-visual: http://127.0.0.1:* http://localhost:*",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The Signal origin of a self-hosted Account API. The Worker still chooses the URL in each ticket;
 * this only lets the peer window open it. It needs `OPENBOT_AUTH_API_URL`, because our Worker never
 * issues a ticket for another Signal.
 */
export function readSelfHostedSignalOrigin(
  authApiUrl: string | undefined,
  signalUrl: string | undefined,
  names = { account: "OPENBOT_AUTH_API_URL", signal: "OPENBOT_REMOTE_SIGNAL_URL" },
): string | null {
  if (!signalUrl) return null;
  if (!authApiUrl) throw new Error(`${names.signal} needs ${names.account}.`);
  const auth = new URL(authApiUrl);
  const url = new URL(signalUrl);
  if (url.protocol !== "wss:" || url.username !== "" || url.password !== "") {
    throw new Error(`${names.signal} must be a wss: URL without credentials.`);
  }
  if (
    [auth.hostname, url.hostname].some(
      (name) =>
        name === "openbot.run" ||
        name.endsWith(".openbot.run") ||
        name === "openbot.site" ||
        name.endsWith(".openbot.site"),
    )
  ) {
    throw new Error("Configure your own Account API and Signal origins.");
  }
  return url.origin;
}

function developmentSignalSource(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ws:" ||
      !isMobileConnectDevelopmentHost(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return "";
    }
    return ` ${url.origin}`;
  } catch {
    return "";
  }
}
