import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Option, Schema } from "effect";
import { isMissingFileError } from "../backend/file-errors";

export const INDEPENDENT_USER_DATA_NAME = "OpenBot Independent";
export const INDEPENDENT_SERVICES_FILE = "independent-services.json";
const MAX_RESOURCE_BYTES = 16 * 1_024;
const ORIGINAL_DOMAINS = ["openbot.run", "openbot.site"];

const servicesSchema = Schema.Struct({
  version: Schema.Literal(1),
  accountUrl: Schema.String.check(Schema.isMaxLength(2_048)),
  signalUrl: Schema.String.check(Schema.isMaxLength(2_048)),
});
export type BundledIndependentServices = typeof servicesSchema.Type;

export class IndependentInstallationError extends Schema.TaggedError<IndependentInstallationError>()(
  "IndependentInstallationError",
  { message: Schema.String },
) {}

interface InstallationEnvironment extends Record<string, string | undefined> {
  OPENBOT_SELF_HOSTED_API_URL?: string;
  OPENBOT_SELF_HOSTED_SIGNAL_URL?: string;
}

export interface IndependentInstallationOptions {
  packaged: boolean;
  independent: boolean;
  rootDesktop: boolean;
  resourcesPath: string;
  appDataPath: string;
  userDataOverride: string;
  environment: InstallationEnvironment;
}

export interface IndependentInstallation {
  userDataPath: string;
  accountUrl: string | null;
  signalUrl: string | null;
}

function invalidConfiguration(): IndependentInstallationError {
  return new IndependentInstallationError({ message: "The independent application service configuration is invalid." });
}

function ownedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfiguration();
  }
  url.hostname = url.hostname.replace(/\.$/u, "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ORIGINAL_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  )
    throw invalidConfiguration();
  return url;
}

function accountOrigin(value: string, allowLoopback: boolean): string {
  const url = ownedUrl(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.pathname !== "/" || (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")))
    throw invalidConfiguration();
  return url.origin;
}

function signalEndpoint(value: string): string {
  const url = ownedUrl(value);
  if (url.protocol !== "wss:" || url.pathname !== "/v1/signal") throw invalidConfiguration();
  return url.href;
}

/** The resource contains public origins only. Unknown fields cannot hide bundled credentials. */
export function parseIndependentServices(contents: string): BundledIndependentServices {
  if (Buffer.byteLength(contents) > MAX_RESOURCE_BYTES) throw invalidConfiguration();
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalidConfiguration();
  }
  if (!isDynamicRecord(parsed)) throw invalidConfiguration();
  const result = Schema.decodeUnknownOption(servicesSchema)(parsed);
  if (Option.isNone(result)) throw invalidConfiguration();
  if (Object.keys(parsed).some((key) => key !== "version" && key !== "accountUrl" && key !== "signalUrl"))
    throw invalidConfiguration();
  return {
    version: 1,
    accountUrl: accountOrigin(result.value.accountUrl, false),
    signalUrl: signalEndpoint(result.value.signalUrl),
  };
}

/** No reads or writes occur for development, upstream builds, or child/server launches. */
export const readIndependentInstallation = Effect.fn("IndependentInstallation.read")(function* (
  options: IndependentInstallationOptions,
): Effect.fn.Return<IndependentInstallation | null, IndependentInstallationError> {
  if (!options.packaged || !options.independent || !options.rootDesktop) return null;
  return yield* Effect.try({
    try: () => {
      let bundled: BundledIndependentServices | null = null;
      try {
        bundled = parseIndependentServices(
          readFileSync(join(options.resourcesPath, INDEPENDENT_SERVICES_FILE), "utf8"),
        );
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      // An explicit empty pair turns the bundled services off. A lone empty account with a
      // nonempty Signal is refused, rather than silently restoring the bundled account.
      const account = options.environment.OPENBOT_SELF_HOSTED_API_URL ?? bundled?.accountUrl;
      const signal = options.environment.OPENBOT_SELF_HOSTED_SIGNAL_URL ?? bundled?.signalUrl;
      const accountUrl = account?.trim() ? accountOrigin(account.trim(), true) : null;
      const signalUrl = signal?.trim() ? signalEndpoint(signal.trim()) : null;
      if (signalUrl && !accountUrl) throw invalidConfiguration();
      return {
        userDataPath: options.userDataOverride.trim()
          ? resolve(options.userDataOverride.trim())
          : join(options.appDataPath, INDEPENDENT_USER_DATA_NAME),
        accountUrl,
        signalUrl,
      };
    },
    catch: () => invalidConfiguration(),
  });
});
