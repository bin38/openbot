import { isMcpRegistryPage, type McpRegistryPage } from "@openbot/contracts/ipc-mcp-registry";

export function decodeMcpRegistryPage(value: unknown): McpRegistryPage {
  if (!isMcpRegistryPage(value)) throw new Error("Invalid MCP registry page.");
  return value;
}
