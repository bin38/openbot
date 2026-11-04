import { defineMessages } from "../../../message";

export const messages = defineMessages("error.e2b", {
  "error.e2b.downloadFailed": "Could not deliver the downloaded cloud file. Try again.",
  "error.e2b.keyMissing": "Add an E2B API key in Cloud computer settings first.",
  "error.e2b.keyUnreadable": "The saved E2B key cannot be decrypted. Enter it again in Cloud computer settings.",
  "error.e2b.storeUnreadable": "Cloud computer state cannot be read. The original file has been kept.",
  "error.e2b.storeWriteFailed": "Cloud computer state could not be saved. No saved binding was replaced.",
  "error.e2b.keyReplacement": "Confirm the E2B account change. Existing cloud computer bindings will be kept.",
  "error.e2b.keyInUse":
    "Confirm removing this key. Existing cloud computers will remain and need the same E2B account to manage them.",
  "error.e2b.busy": "A cloud computer operation is in progress. Wait for it to finish.",
  "error.e2b.agentMissing": "Cannot start a cloud computer for an agent that no longer exists.",
  "error.e2b.machineMissing": "This agent has no cloud computer. Start one first.",
  "error.e2b.machineExpired":
    "E2B no longer has this computer. Its saved binding was kept; delete it before creating another.",
  "error.e2b.notRunning": "Start or resume this cloud computer before using it.",
  "error.e2b.humanControl": "The user has control of this cloud computer. Wait for them to hand it back.",
  "error.e2b.auth": "E2B refused the API key or access to this computer. Check the account in Cloud computer settings.",
  "error.e2b.rateLimit": "E2B reached an account or rate limit. Check your E2B plan and try later.",
  "error.e2b.unavailable": "E2B could not complete this operation. Check its status before repeating a change.",
  "error.e2b.filePath": "Choose a regular workspace file for upload, or a simple file name for download.",
  "error.e2b.stream":
    "The cloud computer viewer could not be changed. Human control remains active until handback succeeds.",
  "error.e2b.viewerFailed": "The cloud computer viewer could not be opened.",
  "error.e2b.declined": "The user declined this cloud computer action.",
  "error.e2b.invalidTemplate":
    "E2B rejected this template or creation settings. Check the template in Cloud computer settings.",
  "error.e2b.creationPending":
    "An E2B creation has an unknown result. Retry Start for the listed agent to recover it before changing the template or account.",
  "error.e2b.createCleanup":
    "The new cloud computer could not be saved or stopped. It will pause at its E2B timeout; check the E2B dashboard before retrying.",
});
