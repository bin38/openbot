import { withoutProviderAccountModelScope } from "@openbot/contracts/account-scoped-models";
import { isClientAgentModelOption, MAX_PROVIDER_ACCOUNTS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodeAccountScopedAgentModels, decodeAgentModels } from "./agent-decoding";

const model = {
  provider: "antigravity",
  id: "gemini-4-argon",
  name: "Gemini 4 Argon",
  description: "Account model fixture",
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: ["low", "medium", "high"],
};
const account = "a0123456789abcdef";

describe("local account-scoped model decoding", () => {
  it("retains valid account metadata and account-specific variants of one model", () => {
    const values = [
      { ...model, providerAccountIds: ["default"] },
      { ...model, supportedReasoningEfforts: ["high"], providerAccountIds: [account] },
    ];
    expect(decodeAccountScopedAgentModels(values)).toEqual(values);
  });

  it.each([
    null,
    "default",
    [],
    ["default", "default"],
    ["a123"],
    ["../../credentials"],
    [123],
    Array.from({ length: MAX_PROVIDER_ACCOUNTS + 1 }, (_, index) => `a${index.toString(16).padStart(16, "0")}`),
  ])("rejects malformed or unbounded local account metadata: %j", (providerAccountIds) => {
    expect(() => decodeAccountScopedAgentModels([{ ...model, providerAccountIds }])).toThrow();
  });

  it("keeps older host payloads and open provider IDs readable without account metadata", () => {
    expect(decodeAccountScopedAgentModels([model])).toEqual([model]);
    const future = { ...model, provider: "future-provider" };
    expect(decodeAccountScopedAgentModels([future])).toEqual([future]);
  });

  it("does not change the released model decoder's meaning", () => {
    const hostModel = { ...model, providerAccountIds: "unknown-host-extension" };
    expect(isClientAgentModelOption(hostModel)).toBe(true);
    expect(decodeAgentModels([hostModel])).toEqual([hostModel]);
    const decoded = decodeAgentModels([hostModel])[0];
    if (!decoded) throw new Error("Missing fixture model.");
    expect(decodeAccountScopedAgentModels([withoutProviderAccountModelScope(decoded)])).toEqual([model]);
  });

  it("still refuses a malformed base model", () => {
    expect(() => decodeAccountScopedAgentModels([{ ...model, id: "", providerAccountIds: [account] }])).toThrow();
  });
});
