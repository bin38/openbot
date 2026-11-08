import { Effect, Result } from "effect";
import type { ColabFailure } from "../../backend/colab-errors";
import type { ColabService } from "../colab-service";
import {
  parseColabCode,
  parseColabCreate,
  parseColabExecute,
  parseColabFiles,
  parseColabSession,
} from "./colab-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

async function run<A>(operation: Effect.Effect<A, ColabFailure>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
}

export function colabIpcHandlers({
  colab,
  openLink,
}: {
  colab: ColabService;
  openLink: (url: string) => Promise<void>;
}): Pick<IpcGroupHandlers, "colab"> {
  return {
    colab: {
      getStatus: handler(() => run(colab.getStatus())),
      refresh: handler(() => run(colab.refresh())),
      startLogin: handler(async () => {
        const status = await run(colab.startLogin());
        const url = colab.takeAutomaticAuthorizationUrl();
        if (url) await openLink(url);
        return status;
      }),
      openAuthorization: handler(() => openLink(colab.authorizationUrl())),
      openHome: handler(() => openLink("https://colab.research.google.com/")),
      submitLoginCode: payloadHandler(parseColabCode, ({ code }) => run(colab.submitLoginCode(code))),
      cancelLogin: handler(() => run(colab.cancelLogin())),
      createCpu: payloadHandler(parseColabCreate, (input) => run(colab.createCpu(input))),
      stop: payloadHandler(parseColabSession, ({ session }) => run(colab.stop(session))),
      openSession: payloadHandler(parseColabSession, async ({ session }) =>
        openLink(await run(colab.sessionUrl(session))),
      ),
      execute: payloadHandler(parseColabExecute, (input) => run(colab.execute(input))),
      listFiles: payloadHandler(parseColabFiles, (input) => run(colab.listFiles(input))),
    },
  };
}
