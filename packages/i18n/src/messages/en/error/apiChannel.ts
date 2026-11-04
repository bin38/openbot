import { defineMessages } from "../../../message";
export const messages = defineMessages("error.apiChannel", {
  "error.apiChannel.declined": "The API operation was not approved. Do not repeat it unless the user asks.",
  "error.apiChannel.invalid":
    "The API channel configuration is invalid. Check its address, operations, parameters, and JSON templates.",
  "error.apiChannel.storage": "The API channel store could not be read or saved. Existing data was preserved.",
  "error.apiChannel.credential": "Save a readable API credential for this channel before enabling it.",
  "error.apiChannel.origin": "A changed API origin needs a newly entered credential. The old credential was not sent.",
  "error.apiChannel.unavailable": "This API channel or operation is unavailable or disabled.",
  "error.apiChannel.parameters":
    "The API input does not match the operation parameters. Check required values and JSON types.",
  "error.apiChannel.file": "This API operation needs a regular file from the calling agent's permitted workspace.",
  "error.apiChannel.request":
    "The API request did not complete. Do not automatically repeat a generation or write request; inspect its run first.",
  "error.apiChannel.http": "The API returned HTTP {status}. Check this channel's credential and service permissions.",
  "error.apiChannel.business":
    "The API reported failure code {code}. Check the service account, entitlement, and request parameters.",
  "error.apiChannel.response": "The API response did not match the configured format or was too large to read safely.",
  "error.apiChannel.run":
    "This API run is unavailable, belongs to another agent, or its channel configuration has changed.",
  "error.apiChannel.artifact":
    "The API artifact could not be retrieved. Check the allowed download hosts and whether the result has expired.",
  "error.apiChannel.pending":
    "The API task is still running. Use its run ID to check again; do not submit another generation request.",
  "error.apiChannel.failed": "The API task failed or was cancelled. Its previous result was retained.",
});
