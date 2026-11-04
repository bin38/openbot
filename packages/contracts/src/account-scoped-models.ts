import { type AgentModelOption, type ClientAgentModelOption, isClientAgentModelOption } from "./ipc-agent-identity";
import { DEFAULT_PROVIDER_ACCOUNT_ID, isProviderAccountId, MAX_PROVIDER_ACCOUNTS } from "./ipc-agent-status";

/** Local IPC metadata. Released Team API model lists keep their existing shape and catalog. */
export interface AccountScopedAgentModelOption extends AgentModelOption {
  /** Absent for an older host or a provider whose catalog is not scoped by account. */
  providerAccountIds?: string[];
}

/** A local model response can also contain unchanged choices from a remote, newer provider. */
export interface AccountScopedClientAgentModelOption extends ClientAgentModelOption {
  providerAccountIds?: string[];
}

export function isAccountScopedClientAgentModelOption(value: unknown): value is AccountScopedClientAgentModelOption {
  if (!isClientAgentModelOption(value)) return false;
  if (!("providerAccountIds" in value)) return true;
  const accounts = value.providerAccountIds;
  return (
    accounts === undefined ||
    (Array.isArray(accounts) &&
      accounts.length > 0 &&
      accounts.length <= MAX_PROVIDER_ACCOUNTS &&
      accounts.every(isProviderAccountId) &&
      new Set(accounts).size === accounts.length)
  );
}

/** Missing metadata retains the existing behavior of remote hosts and single-account providers. */
export function modelSupportsProviderAccount(
  model: AccountScopedClientAgentModelOption,
  accountId: string | null | undefined,
): boolean {
  return (
    model.providerAccountIds === undefined ||
    model.providerAccountIds.includes(accountId ?? DEFAULT_PROVIDER_ACCOUNT_ID)
  );
}

/** A remote response cannot claim the local IPC account-catalog extension. */
export function withoutProviderAccountModelScope(model: AccountScopedClientAgentModelOption): ClientAgentModelOption {
  const { providerAccountIds: _accounts, ...option } = model;
  return option;
}
