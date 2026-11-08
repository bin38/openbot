import type { GeminiProxySettings } from "@openbot/contracts/ipc";

const LOOPBACK_BYPASS = "localhost,127.0.0.1,::1,[::1]";

/**
 * Gemini's external HTTP clients use this proxy even when the parent has conflicting variables.
 * The ACP server and its local harness still communicate directly. This changes only the child
 * environment; it neither changes the system proxy nor the proxy application's routing rules.
 */
export function geminiProxyEnvironment(settings: GeminiProxySettings | undefined): Record<string, string> {
  if (!settings?.enabled) return {};
  const environment: Record<string, string> = {};
  for (const name of ["HTTP", "HTTPS", "ALL", "WS", "WSS"]) {
    environment[`${name}_PROXY`] = settings.proxyUrl;
    environment[`${name.toLowerCase()}_proxy`] = settings.proxyUrl;
  }
  environment.NO_PROXY = LOOPBACK_BYPASS;
  environment.no_proxy = LOOPBACK_BYPASS;
  environment.SOCKS_PROXY = "";
  environment.socks_proxy = "";
  // gRPC implementations that support these standard variables get the same route and bypass.
  environment.GRPC_PROXY = settings.proxyUrl;
  environment.grpc_proxy = settings.proxyUrl;
  environment.NO_GRPC_PROXY = LOOPBACK_BYPASS;
  environment.no_grpc_proxy = LOOPBACK_BYPASS;
  return environment;
}

/** A disabled setting must not invalidate a client just because the saved address was edited. */
export function geminiProxyFingerprint(settings: GeminiProxySettings | undefined): string | null {
  return settings?.enabled ? settings.proxyUrl : null;
}
