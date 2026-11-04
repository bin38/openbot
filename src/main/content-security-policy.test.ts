import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  configuredSelfHostedSignalOrigin,
  readSelfHostedSignalOrigin,
} from "./content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it.each([true, false])("admits only the configured independent Signal when packaged=%s", (packaged) => {
    const origin = configuredSelfHostedSignalOrigin(
      {
        OPENBOT_SELF_HOSTED_API_URL: "https://account.example.com",
        OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://signal.example.com/v1/signal",
        OPENBOT_AUTH_API_URL: "https://legacy.example.net",
        OPENBOT_REMOTE_SIGNAL_URL: "wss://legacy.example.net/v1/signal",
      },
      true,
    );
    const connect = buildContentSecurityPolicy(packaged, undefined, origin)
      .split("; ")
      .find((value) => value.startsWith("connect-src "));
    expect(origin).toBe("wss://signal.example.com");
    expect(connect).toContain(" wss://signal.example.com");
    expect(connect).not.toContain("legacy.example.net");
    expect(connect).not.toMatch(/(?:^|\s)wss:(?:\s|$)/u);
  });

  it("does not use legacy settings as an independent Signal opt-in", () => {
    const environment = {
      OPENBOT_AUTH_API_URL: "https://account.example.com",
      OPENBOT_REMOTE_SIGNAL_URL: "wss://signal.example.com/v1/signal",
    };
    expect(configuredSelfHostedSignalOrigin(environment, true)).toBeNull();
    expect(configuredSelfHostedSignalOrigin(environment, false)).toBe("wss://signal.example.com");
    expect(() =>
      configuredSelfHostedSignalOrigin({ OPENBOT_SELF_HOSTED_SIGNAL_URL: "wss://signal.example.com/v1/signal" }, true),
    ).toThrow("OPENBOT_SELF_HOSTED_SIGNAL_URL needs OPENBOT_SELF_HOSTED_API_URL.");
  });

  it.each([
    "ws://signal.example.com/v1/signal",
    "wss://user:pass@signal.example.com/v1/signal",
    "wss://signal.openbot.run/v1/signal",
  ])("refuses an unsafe independent Signal: %s", (signal) => {
    expect(() =>
      configuredSelfHostedSignalOrigin(
        { OPENBOT_SELF_HOSTED_API_URL: "https://account.example.com", OPENBOT_SELF_HOSTED_SIGNAL_URL: signal },
        true,
      ),
    ).toThrow();
  });

  it("does not permit the upstream analytics, Signal, or hosted frames", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain("connect-src 'self' openbot-attachment: openbot-remote-attachment: ws://127.0.0.1:*");
    expect(policy).not.toContain("openbot.run");
    expect(policy.split("; ").find((directive) => directive.startsWith("connect-src "))).not.toContain("localhost");
  });

  it.each([true, false])("allows loopback viewer frames when packaged=%s", (packaged) => {
    const directives = buildContentSecurityPolicy(packaged).split("; ");
    expect(directives.find((directive) => directive.startsWith("frame-src "))).toBe(
      "frame-src 'self' openbot-attachment: openbot-remote-attachment: openbot-visual: openbot-remote-visual: http://127.0.0.1:* http://localhost:*",
    );
    expect(directives.find((directive) => directive.startsWith("script-src "))).toBe("script-src 'self'");
  });

  it("lets the renderer play an attachment recording, but only from the attachment schemes", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment:");
    expect(policy).not.toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment: https:");
  });

  it("keeps local development sources", () => {
    const policy = buildContentSecurityPolicy(false, "ws://192.168.1.143:3101/v1/signal");

    expect(policy).toContain("http://localhost:*");
    expect(policy).toContain("ws://localhost:*");
    expect(policy).toContain("ws://192.168.1.143:3101");
  });

  it("does not add public or production Signal origins through the development option", () => {
    expect(buildContentSecurityPolicy(false, "ws://signal.example.com/v1/signal")).not.toContain(
      "ws://signal.example.com",
    );
    expect(buildContentSecurityPolicy(true, "ws://192.168.1.143:3101/v1/signal")).not.toContain(
      "ws://192.168.1.143:3101",
    );
  });

  it("adds only the origin of a self-hosted Signal to connect-src", () => {
    const origin = readSelfHostedSignalOrigin("https://api.example.com", "wss://signal.example.com:8443/v1/signal");
    const connect = buildContentSecurityPolicy(true, undefined, origin)
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));

    expect(origin).toBe("wss://signal.example.com:8443");
    expect(connect).toContain(" wss://signal.example.com:8443");
    expect(readSelfHostedSignalOrigin(undefined, undefined)).toBeNull();
  });

  it.each([
    [undefined, "wss://signal.example.com/v1/signal", "OPENBOT_REMOTE_SIGNAL_URL needs OPENBOT_AUTH_API_URL."],
    ["https://api.example.com", "ws://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "https://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "wss://user:pass@signal.example.com/v1/signal", "must be a wss: URL"],
  ])("refuses a self-hosted Signal URL with auth API %s and Signal %s", (authApiUrl, signalUrl, message) => {
    expect(() => readSelfHostedSignalOrigin(authApiUrl, signalUrl)).toThrow(message);
  });

  it("does not restore vendor access through an old self-hosted environment setting", () => {
    expect(() => readSelfHostedSignalOrigin("https://api.openbot.run", "wss://signal.example.com/v1/signal")).toThrow(
      "Configure your own",
    );
    expect(() => readSelfHostedSignalOrigin("https://api.example.com", "wss://signal.openbot.run/v1/signal")).toThrow(
      "Configure your own",
    );
  });
});
