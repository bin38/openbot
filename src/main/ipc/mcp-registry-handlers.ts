import type { McpRegistryQuery } from "@openbot/contracts/ipc-mcp-registry";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result } from "effect";
import type { McpRegistryService } from "../mcp-registry-service";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

function decodeMcpRegistryQuery(value: unknown): McpRegistryQuery {
  if (!isDynamicRecord(value) || Object.keys(value).some((key) => !["query", "cursor", "refresh"].includes(key)))
    throw new Error("Invalid registry search.");
  const { query, cursor, refresh } = value;
  if (query !== undefined && (typeof query !== "string" || query.length > 200))
    throw new Error("Invalid registry query.");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4096))
    throw new Error("Invalid registry cursor.");
  if (refresh !== undefined && typeof refresh !== "boolean") throw new Error("Invalid registry refresh.");
  return {
    ...(query === undefined ? {} : { query }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(refresh === undefined ? {} : { refresh }),
  };
}

export function mcpRegistryIpcHandlers(registry: McpRegistryService): Pick<IpcGroupHandlers, "mcpRegistry"> {
  return {
    mcpRegistry: {
      search: payloadHandler(decodeMcpRegistryQuery, async (input) => {
        const result = await Effect.runPromise(Effect.result(registry.search(input)));
        if (Result.isFailure(result)) throw new Error(result.failure.message);
        return result.success;
      }),
    },
  };
}
