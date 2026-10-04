import { BaseError, ContractFunctionRevertedError } from "viem";

const REVERT_TEXT: Record<string, string> = {
  StaleOracle: "Chainlink HBAR/USD is older than the engine allows. Buybacks wait for the next update.",
  BadOraclePrice: "Chainlink returned a non-positive HBAR/USD answer.",
  ZeroAmount: "Enter an amount above zero.",
  ZeroAddress: "Enter a recipient address.",
  NotInitialized: "The engine has not created its token yet.",
  AlreadyInitialized: "The engine already created its token.",
  PoolExists: "The pool already exists.",
  PoolMissing: "Create the pool before seeding it.",
  AlreadySeeded: "The liquidity allocation is already in the pool.",
  InsufficientFee: "Send at least the pool creation fee shown above.",
  HtsCallFailed: "A Hedera Token Service call inside the engine failed.",
  TransferFailed: "A token transfer inside the engine failed. Check that the recipient is associated with the token.",
  NothingBought: "The swap delivered no tokens, so nothing was burned.",
  AllocationBreach: "The burn would have touched the pool or team allocation, so it was rolled back.",
  AutomationActive: "Automation is already running. Stop it before starting with a new interval.",
  BadInterval: "Interval is outside the engine's allowed range.",
  BadConfig: "The engine refused that value. Check it against the bounds shown.",
  ScheduleFailed: "Hedera refused to book the schedule. Check the engine's fuel balance.",
  NotOwnerOrSelf: "Only the engine owner can do that.",
  OwnableUnauthorizedAccount: "Only the engine owner can do that.",
};

/** Name of the custom error a call reverted with, when the node returned revert data. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(e => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export function explainError(error: unknown): string {
  const name = revertName(error);
  if (name) return REVERT_TEXT[name] ?? `The engine reverted with ${name}.`;
  const code = (error as { code?: number } | undefined)?.code;
  const text = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : "";
  if (code === 4001 || /user rejected|user denied/i.test(text)) return "Rejected in the wallet.";
  return text || "The transaction failed.";
}
