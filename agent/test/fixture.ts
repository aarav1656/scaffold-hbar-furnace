import { type Address, encodeAbiParameters, encodeEventTopics, parseAbiParameters, toEventSelector } from "viem";
import { engineAbi } from "../src/abi";
import type { BurnLedger, ChainReader, ContractResult, RawState } from "../src/chain";
import { configFromEnv } from "../src/config";

export const ENGINE: Address = "0x3249617e95785640140a05f55fd9c798f0e116df";
export const OWNER: Address = "0x11Cf661848D52aEdF638658E6b68762549f74a0C";
export const STRANGER: Address = "0x00000000000000000000000000000000000000de";
export const TOKEN: Address = "0x0000000000000000000000000000000000a5B86E";
export const SCHEDULE: Address = "0x0000000000000000000000000000000000A5B904";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const cfg = () => configFromEnv({ FURNACE_ENGINE: ENGINE });

/** The v2 engine as read from testnet on 2026-10-04 (consensus second 1791141071), with every field editable. */
export function state(over: { status?: Partial<RawState["status"]>; policy?: Partial<RawState["policy"]>; preview?: RawState["preview"] } & Partial<Omit<RawState, "status" | "policy" | "preview">> = {}): RawState {
  const { status, policy, preview, ...rest } = over;
  return {
    engine: ENGINE,
    owner: OWNER,
    status: {
      token: TOKEN,
      pair: "0xfa7511E92d54c29E469A88aE67334b7b1c2C0806",
      lpToken: "0x0000000000000000000000000000000000a5B870",
      totalSupply: 98_866_156_743_165n,
      totalBurned: 1_133_843_256_835n,
      totalSpentHbar: 292_608_047n,
      spentTodayUsd: 30_000_000n,
      budgetLeftUsd: 470_000_000n,
      priceHbar: 26_482n,
      priceUsd: 2_732n,
      hbarUsd: 10_317_307n,
      reserveHbar: 7_139_781_587n,
      reserveToken: 38_866_156_743_165n,
      teamUnclaimed: 0n,
      liquidityUnseeded: 0n,
      balance: 10_292_608_047n,
      fuel: 2_500_000_000n,
      nextRunAt: 1_791_141_365n,
      pendingSchedule: SCHEDULE,
      interval: 2100n,
      twapPriceHbar: 26_400n,
      twapWindow: 900n,
      twapDeviationBps: 31n,
      lastBuyAt: 1_791_140_000n,
      nextBuyAt: 0n,
      ...status,
    },
    tokenSymbol: "FURN",
    tokenDecimals: 8,
    policy: {
      dailyBudgetUsd: 500_000_000n,
      maxImpactBps: 500n,
      priceCeilingUsd: 30_000_000n,
      slippageBps: 300n,
      maxLotUsd: 100_000_000n,
      minGapSeconds: 900n,
      maxTwapDeviationBps: 500n,
      minSpend: 100_000_000n,
      fuelReserve: 2_500_000_000n,
      scheduledGas: 4_000_000n,
      ...policy,
    },
    preview: preview ?? { ok: true, skip: 0, spend: 290_773_551n },
    rearmGrace: 600n,
    gasPriceWeibar: 870_000_000_000n,
    nowSeconds: 1_791_141_071,
    ...rest,
  };
}

export const ledger = (over: Partial<BurnLedger> = {}): BurnLedger => ({
  split: { network: { burns: 3, tokensBurned: 600_000_000_000n, hbarSpent: 150_000_000n }, manual: { burns: 1, tokensBurned: 533_843_256_835n, hbarSpent: 142_608_047n } },
  reconciled: true,
  mirrorTotalBurned: 1_133_843_256_835n,
  lastRunFeeTinybar: 141_794_436n,
  ...over,
});

type Stub = {
  cfg: ReturnType<typeof cfg>;
  state: RawState;
  /** State after the transaction, for tools that read back. */
  stateAfter: RawState | null;
  evm: Address;
  hbarBalance: bigint;
  result: ContractResult;
  ledger: BurnLedger;
  quote: bigint | null;
  calls: string[];
};

export const result = (logs: ContractResult["logs"] = [], over: Partial<ContractResult> = {}): ContractResult => ({ result: "SUCCESS", hash: "0xabc", gas_used: 1, error_message: null, logs, ...over });

/** A mirror-node log for an engine event, encoded the way the chain emits it. */
export function log(eventName: string, args: Record<string, unknown>, address: Address = ENGINE) {
  const item = engineAbi.find((i) => i.type === "event" && i.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi: engineAbi, eventName: eventName as never, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) as never });
  const data = encodeAbiParameters(
    parseAbiParameters(item.inputs.filter((i) => !i.indexed).map((i) => `${i.type} ${i.name}`).join(", ")),
    item.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never,
  );
  return { address, data, topics: topics as `0x${string}`[], index: 0 };
}
export const selector = (sig: string) => toEventSelector(sig);

export function stubChain(over: Partial<Stub> = {}): ChainReader & { calls: string[] } {
  const s: Stub = { cfg: cfg(), state: state(), stateAfter: null, evm: OWNER, hbarBalance: 100n * 10n ** 18n, result: result(), ledger: ledger(), quote: 1_064_714_082_776n, calls: [], ...over };
  let reads = 0;
  return {
    cfg: s.cfg,
    calls: s.calls,
    readState: async () => (reads++ > 0 && s.stateAfter ? s.stateAfter : s.state),
    burnLedger: async () => s.ledger,
    quoteBuy: async () => s.quote,
    account: async (id) => ({ accountId: id.startsWith("0.0.") ? id : "0.0.10855086", evmAddress: id.startsWith("0x") ? (id as Address) : s.evm }),
    waitForResult: async (id) => (s.calls.push(`waitForResult ${id}`), s.result),
    hbarBalance: async () => s.hbarBalance,
  };
}
