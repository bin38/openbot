import { defineMessages } from "../../message";
export const messages = defineMessages("colab", {
  "colab.title": "Colab cloud notebooks",
  "colab.description":
    "Connect the official local Colab CLI, run Python and notebooks, and use your Google account's runtimes.",
  "colab.refresh": "Refresh runtimes",
  "colab.openHome": "Open Colab website",
  "colab.installed": "Colab CLI {version} is installed",
  "colab.missing": "Colab CLI was not found on this computer.",
  "colab.proxyNote":
    "Colab reuses the enabled Gemini app proxy. Internal connections remain direct; system proxy settings are not changed.",
  "colab.connected": "Connection verified",
  "colab.credentialsSaved": "CLI sign-in saved; refresh to verify",
  "colab.notConnected": "Not connected",
  "colab.loginHelp":
    "Use the official CLI's saved sign-in, or authorize Google in your browser. The page may name Google Cloud SDK, the client used by the official CLI. Choose the Google account you want to use; OpenBot does not receive its password.",
  "colab.login": "Sign in with Google",
  "colab.codeHelp": "Approve the Google page, then paste the authorization code here. Do not send it in chat.",
  "colab.authorizationCode": "Google authorization code",
  "colab.openAuthorization": "Open Google sign-in",
  "colab.submitCode": "Finish sign-in",
  "colab.sessionsTitle": "Runtime sessions",
  "colab.sessionsHelp":
    "The CLI manages runtimes, not a library of Drive notebooks. Open the session in Colab to work with the notebook interface.",
  "colab.sessionDetails": "{hardware} · {shape} · {state}",
  "colab.busy": "Running",
  "colab.idle": "Idle",
  "colab.unknown": "Status not checked",
  "colab.selectSession": "Use this runtime",
  "colab.openSession": "Open in Colab",
  "colab.empty": "No named CLI runtime sessions. Create a CPU runtime when you need one.",
  "colab.unmanaged": {
    one: "One remote runtime is managed by another client. Manage it on the Colab website.",
    other: "{count} remote runtimes are managed by another client. Manage them on the Colab website.",
  },
  "colab.stop": "Stop runtime",
  "colab.stopTitle": "Stop this Colab runtime?",
  "colab.stopDescription":
    "This shuts down the selected remote runtime. Files kept only on that VM can be lost. Download your results first.",
  "colab.sessionName": "New runtime name",
  "colab.cpuHelp": "Creates a CPU runtime only when you click Create. Availability and usage follow your Colab plan.",
  "colab.createCpu": "Create CPU runtime",
  "colab.executeTitle": "Run Python",
  "colab.executeHelp":
    "Code runs in the selected remote runtime and can change its files. Assistants can also run workspace notebooks and transfer approved files.",
  "colab.selectedSession": "Runtime name",
  "colab.code": "Python code",
  "colab.execute": "Run code",
  "colab.output": "Execution output",
  "colab.truncated": "Output was shortened. Save large results to a file and download it.",
  "colab.actionFailed": "The Colab action did not finish.",
  "colab.loadFailed": "Could not read the local Colab CLI status.",
});
