import type { McpServerConfig } from "./ipc-mcp-servers";
import { isDynamicRecord, isString } from "./runtime-values";

export interface McpRegistryQuery {
  query?: string;
  cursor?: string;
  refresh?: boolean;
}

export interface McpRegistryField {
  name: string;
  label: string;
  description: string;
  target: "env" | "header";
  required: boolean;
  secret: boolean;
}

export interface McpRegistryConnection {
  id: string;
  transport: "http" | "stdio";
  url: string;
  command: string;
  args: string[];
  fields: McpRegistryField[];
}

export interface McpRegistryServer {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string | null;
  connections: McpRegistryConnection[];
}

export interface McpRegistryPage {
  servers: McpRegistryServer[];
  nextCursor: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface McpRegistryApi {
  search(input: McpRegistryQuery): Promise<McpRegistryPage>;
}

const text = (value: unknown, limit: number): value is string => isString(value) && value.length <= limit;

export function isMcpRegistryPage(value: unknown): value is McpRegistryPage {
  return (
    isDynamicRecord(value) &&
    text(value.fetchedAt, 64) &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.stale === "boolean" &&
    (value.nextCursor === null || text(value.nextCursor, 4096)) &&
    Array.isArray(value.servers) &&
    value.servers.length <= 50 &&
    value.servers.every(
      (server) =>
        isDynamicRecord(server) &&
        text(server.name, 256) &&
        text(server.title, 256) &&
        text(server.description, 4096) &&
        text(server.version, 128) &&
        (server.websiteUrl === null || text(server.websiteUrl, 2048)) &&
        Array.isArray(server.connections) &&
        server.connections.length <= 8 &&
        server.connections.every(
          (connection) =>
            isDynamicRecord(connection) &&
            text(connection.id, 64) &&
            (connection.transport === "http" || connection.transport === "stdio") &&
            text(connection.url, 2048) &&
            text(connection.command, 64) &&
            Array.isArray(connection.args) &&
            connection.args.length <= 64 &&
            connection.args.every((arg) => text(arg, 4096)) &&
            Array.isArray(connection.fields) &&
            connection.fields.length <= 32 &&
            connection.fields.every(
              (field) =>
                isDynamicRecord(field) &&
                text(field.name, 128) &&
                text(field.label, 256) &&
                text(field.description, 2048) &&
                (field.target === "env" || field.target === "header") &&
                typeof field.required === "boolean" &&
                typeof field.secret === "boolean",
            ),
        ),
    )
  );
}

/** This is a new configuration, never an update of an existing server. Values come only from the user's form. */
export function registryMcpConfig(
  name: string,
  connection: McpRegistryConnection,
  values: Record<string, string>,
): McpServerConfig {
  const pairs = (target: McpRegistryField["target"]) =>
    connection.fields.flatMap((field) => {
      const value = values[`${field.target}:${field.name}`] ?? "";
      return field.target === target && value ? [{ key: field.name, value }] : [];
    });
  return {
    id: "",
    name: name.trim(),
    enabled: true,
    transport: connection.transport,
    url: connection.url,
    command: connection.command,
    args: [...connection.args],
    workingDirectory: "",
    envPassthrough: [],
    env: pairs("env"),
    headers: pairs("header"),
  };
}
