import { defineMessages } from "../../../message";
export const messages = defineMessages("error.colab", {
  "error.colab.missing": "Install the official Google Colab CLI on this computer, then try again.",
  "error.colab.authRequired": "Sign in to Colab in Server settings before using this operation.",
  "error.colab.loginPending": "A Colab sign-in is in progress. Complete or cancel it first.",
  "error.colab.loginFailed": "Colab sign-in did not finish. Check the Google authorization and try again.",
  "error.colab.commandFailed": "The Colab CLI operation failed. Check the session, Google account and app proxy.",
  "error.colab.timeout": "The Colab request timed out. Remote code may still be running.",
  "error.colab.cancelled": "The local Colab request was cancelled. Remote code may still be running.",
  "error.colab.invalid": "The Colab request is not valid.",
  "error.colab.file": "OpenBot could not use this Colab file. Use an approved regular workspace file.",
  "error.colab.fileExists": "The output file already exists. Choose another name.",
  "error.colab.sessionMissing":
    "The Colab runtime was not found. Refresh the runtime list and select an active session.",
  "error.colab.proxy": "The Colab CLI could not connect to the app proxy. Check the Gemini proxy settings.",
  "error.colab.allocation":
    "Colab could not allocate a runtime. Check active sessions, quota and current capacity, then try again.",
  "error.colab.cacheUnsafe": "OpenBot could not secure the Colab CLI cache. Check its ownership and file permissions.",
});
