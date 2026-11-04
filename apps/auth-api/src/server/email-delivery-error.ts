import { Schema } from "effect";

export class EmailDeliveryError extends Schema.TaggedError<EmailDeliveryError>()("EmailDeliveryError", {
  message: Schema.String,
}) {}
