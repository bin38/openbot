import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/e2b";

// New cloud-computer messages use the English fallback until translated.
export const messages = {} as const satisfies PartialTranslation<typeof source>;
