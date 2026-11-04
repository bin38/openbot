import { isMobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { Option, Schema } from "effect";
import { PreferenceStore } from "./preference-file";

export const LOCAL_MOBILE_CONSENT_FILE = "local-mobile-publication-v1.json";

const consentSchema = Schema.Struct({
  accountId: Schema.NonEmptyString,
  accountOrigin: Schema.NonEmptyString,
  hostId: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
});
const preferenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  consent: Schema.NullOr(consentSchema),
});

export type LocalMobileConsent = typeof consentSchema.Type;
export type LocalMobileConsentStore = PreferenceStore<{ consent: LocalMobileConsent | null }>;

/** A local opt-in, with no credential. Missing or invalid data never grants network access. */
export function createLocalMobileConsentStore(path: string): LocalMobileConsentStore {
  return new PreferenceStore<{ consent: LocalMobileConsent | null }>({
    path,
    defaultValue: { consent: null },
    decode: (parsed) => {
      const decoded = Schema.decodeUnknownOption(preferenceSchema)(parsed);
      if (Option.isNone(decoded)) return null;
      const consent = decoded.value.consent;
      if (consent === null) return { consent: null };
      if (!isMobileConnectHostBinding(consent) || !URL.canParse(consent.accountOrigin)) return null;
      const origin = new URL(consent.accountOrigin);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (
        origin.origin !== consent.accountOrigin ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
      )
        return null;
      return { consent };
    },
  });
}
