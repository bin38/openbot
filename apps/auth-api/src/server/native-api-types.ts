/** The native account handlers need only the request and decoded path parameters. */
interface NativeApiContext<Params> {
  request: Request;
  params: Params;
}

export type NativeApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type NativeApiHandlers<Params = Record<never, never>> = Partial<
  Record<NativeApiMethod, (context: NativeApiContext<Params>) => Response | Promise<Response>>
>;
