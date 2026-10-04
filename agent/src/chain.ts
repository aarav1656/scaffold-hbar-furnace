import { type Address, BaseError, ContractFunctionRevertedError, type Hex, createPublicClient, decodeErrorResult, decodeEventLog, http, toEventSelector } from "viem";
import { hederaTestnet } from "viem/chains";
import { engineAbi, erc20Abi, routerAbi } from "./abi";
import { type BurnEvent, type BurnSplit, type Preview, splitBurns } from "./analysis";
import type { EngineConfig } from "./config";

export type Status = {
  token: Address;
  pair: Address;
  lpToken: Address;
  totalSupply: bigint;
  totalBurned: bigint;
  totalSpentHbar: bigint;
  spentTodayUsd: bigint;
  budgetLeftUsd: bigint;
  priceHbar: bigint;
  priceUsd: bigint;
  hbarUsd: bigint;
  reserveHbar: bigint;
  reserveToken: bigint;
  teamUnclaimed: bigint;
  liquidityUnseeded: bigint;
  balance: bigint;
  fuel: bigint;
  nextRunAt: bigint;
  pendingSchedule: Address;
  interval: bigint;
  twapPriceHbar: bigint;
  twapWindow: bigint;
  twapDeviationBps: bigint;
  lastBuyAt: bigint;
  nextBuyAt: bigint;
};

/** Everything one state read returns, as raw chain values. `shapeState` turns it into the tool result. */
export type RawState = {
  engine: Address;
  owner: Address;
  status: Status;
  tokenSymbol: string;
  tokenDecimals: number;
  policy: {
    dailyBudgetUsd: bigint;
    maxImpactBps: bigint;
    priceCeilingUsd: bigint;
    slippageBps: bigint;
    maxLotUsd: bigint;
    minGapSeconds: bigint;
    maxTwapDeviationBps: bigint;
    minSpend: bigint;
    fuelReserve: bigint;
    scheduledGas: bigint;
  };
  /** What buyback() would do now: the Skip code and the tinybar it would spend, or why it cannot be priced. */
  preview: Preview;
  rearmGrace: bigint;
  gasPriceWeibar: bigint;
  nowSeconds: number;
};

export type MirrorLog = { address: string; data: Hex; topics: Hex[]; index: number };
export type ContractResult = { result: string; hash: string; gas_used: number; error_message: string | null; logs: MirrorLog[] };

export type BurnLedger = {
  split: BurnSplit;
  /** Sum of every Burned event on the mirror node equals the engine's own totalBurned(). False means the mirror read is incomplete. */
  reconciled: boolean;
  mirrorTotalBurned: bigint;
  lastRunFeeTinybar: bigint | null;
};

/** What the tools need from the chain. `EngineChain` is the live implementation; tests pass a stub. */
export interface ChainReader {
  readonly cfg: EngineConfig;
  readState(): Promise<RawState>;
  burnLedger(totalBurned: bigint): Promise<BurnLedger>;
  /** Tokens a router swap of `spendTinybar` HBAR returns right now, or null when the quote is unavailable. */
  quoteBuy(token: Address, spendTinybar: bigint): Promise<bigint | null>;
  account(idOrAddress: string): Promise<{ accountId: string; evmAddress: Address }>;
  waitForResult(txId: string): Promise<ContractResult>;
  /** Native HBAR balance in weibar (18 decimals), as JSON-RPC reports it. */
  hbarBalance(account: Address): Promise<bigint>;
}

export class MirrorError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Mirror node answered ${status} for ${path}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW_SECONDS = 6 * 86_400; // the mirror node rejects topic filters over a timestamp range wider than 7 days
const MAX_WINDOWS = 60;
const MAX_PAGES = 30;

/** The engine's custom error behind a failed call, or null when the error carries no revert data. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const hit = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return hit instanceof ContractFunctionRevertedError ? (hit.data?.errorName ?? hit.reason ?? null) : null;
}

/** Decodes the revert bytes the mirror node stores for a failed call, e.g. `NotOwnerOrSelf()`. */
export function decodeRevert(data: string | null | undefined): { name: string; args: string[] } | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi: engineAbi, data: data as Hex });
    return { name: decoded.errorName, args: (decoded.args ?? []).map((a) => String(a)) };
  } catch {
    return null;
  }
}

export class EngineChain implements ChainReader {
  private readonly rpc;
  private created: number | null = null;

  constructor(readonly cfg: EngineConfig) {
    this.rpc = createPublicClient({ chain: hederaTestnet, transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 400 }) });
  }

  async mirror<T>(path: string): Promise<T> {
    const res = await fetch(path.startsWith("/api/") ? `${this.cfg.mirrorUrl}${path}` : `${this.cfg.mirrorUrl}/api/v1${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new MirrorError(res.status, path);
    return (await res.json()) as T;
  }

  private read<T>(address: Address, abi: typeof engineAbi | typeof erc20Abi | typeof routerAbi, functionName: string, args: unknown[] = []) {
    return this.rpc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }

  async readState(): Promise<RawState> {
    const e = this.cfg.engine;
    const r = <T>(fn: string) => this.read<T>(e, engineAbi, fn);
    const [owner, status, preview, rearmGrace, gasPriceWeibar, ...policy] = await Promise.all([
      r<Address>("owner"),
      r<Status>("status"),
      this.preview(),
      r<bigint>("REARM_GRACE"),
      this.rpc.getGasPrice(),
      ...["dailyBudgetUsd", "maxImpactBps", "priceCeilingUsd", "slippageBps", "maxLotUsd", "minGapSeconds", "maxTwapDeviationBps", "minSpend", "fuelReserve", "scheduledGas"].map((fn) => r<bigint>(fn)),
    ]);
    const [tokenSymbol, tokenDecimals] =
      status.token === "0x0000000000000000000000000000000000000000"
        ? ["", 0]
        : await Promise.all([this.read<string>(status.token, erc20Abi, "symbol"), this.read<number>(status.token, erc20Abi, "decimals")]);
    const [dailyBudgetUsd, maxImpactBps, priceCeilingUsd, slippageBps, maxLotUsd, minGapSeconds, maxTwapDeviationBps, minSpend, fuelReserve, scheduledGas] = policy as bigint[];
    return {
      engine: e,
      owner,
      status,
      tokenSymbol,
      tokenDecimals: Number(tokenDecimals),
      policy: {
        dailyBudgetUsd: dailyBudgetUsd!,
        maxImpactBps: maxImpactBps!,
        priceCeilingUsd: priceCeilingUsd!,
        slippageBps: slippageBps!,
        maxLotUsd: maxLotUsd!,
        minGapSeconds: minGapSeconds!,
        maxTwapDeviationBps: maxTwapDeviationBps!,
        minSpend: minSpend!,
        fuelReserve: fuelReserve!,
        scheduledGas: scheduledGas!,
      },
      preview,
      rearmGrace,
      gasPriceWeibar,
      nowSeconds: Math.floor(Date.now() / 1000),
    };
  }

  private async preview(): Promise<Preview> {
    try {
      const [skip, spend] = await this.read<readonly [number, bigint]>(this.cfg.engine, engineAbi, "previewBuyback");
      return { ok: true, skip: Number(skip), spend };
    } catch (error) {
      const name = revertName(error);
      if (name !== "StaleOracle" && name !== "BadOraclePrice") throw error;
      return { ok: false, reason: name };
    }
  }

  private async createdSeconds() {
    if (this.created === null) {
      const c = await this.mirror<{ created_timestamp: string }>(`/contracts/${this.cfg.engine}`);
      this.created = Math.floor(Number(c.created_timestamp.split(".")[0]));
    }
    return this.created;
  }

  /** Every log of one event, oldest first, across the engine's whole life in 6 day windows, following mirror pagination. */
  private async eventLogs(signature: string) {
    const topic0 = toEventSelector(signature);
    const now = Math.floor(Date.now() / 1000);
    const rows: { timestamp: string; data: Hex }[] = [];
    let from = await this.createdSeconds();
    for (let w = 0; w < MAX_WINDOWS && from <= now; w++, from += WINDOW_SECONDS + 1) {
      let path: string | null = `/contracts/${this.cfg.engine}/results/logs?topic0=${topic0}&timestamp=gte:${from}&timestamp=lte:${Math.min(from + WINDOW_SECONDS, now)}&order=asc&limit=100`;
      for (let page = 0; path && page < MAX_PAGES; page++) {
        const body: { logs: { timestamp: string; data: Hex }[]; links?: { next?: string | null } } = await this.mirror(path);
        rows.push(...body.logs);
        path = body.links?.next ?? null;
      }
    }
    return rows;
  }

  async burnLedger(totalBurned: bigint): Promise<BurnLedger> {
    const [burnedLogs, runLogs] = await Promise.all([this.eventLogs("Burned(uint256,uint256,uint256,uint256,uint256)"), this.eventLogs("ScheduledRun(uint256)")]);
    const burned: BurnEvent[] = burnedLogs.map((l) => {
      const ev = decodeEventLog({ abi: engineAbi, eventName: "Burned", data: l.data, topics: [toEventSelector("Burned(uint256,uint256,uint256,uint256,uint256)")] });
      const a = ev.args as unknown as { tokensBurned: bigint; hbarIn: bigint };
      return { timestamp: l.timestamp, tokensBurned: a.tokensBurned, hbarIn: a.hbarIn };
    });
    const split = splitBurns(burned, new Set(runLogs.map((l) => l.timestamp)));
    const mirrorTotal = split.network.tokensBurned + split.manual.tokensBurned;
    let lastRunFeeTinybar: bigint | null = null;
    const newest = runLogs.at(-1);
    if (newest) {
      const { transactions } = await this.mirror<{ transactions: { charged_tx_fee: number }[] }>(`/transactions?timestamp=${newest.timestamp}`);
      if (transactions.length > 0) lastRunFeeTinybar = BigInt(transactions[0]!.charged_tx_fee);
    }
    return { split, reconciled: mirrorTotal === totalBurned, mirrorTotalBurned: mirrorTotal, lastRunFeeTinybar };
  }

  async quoteBuy(token: Address, spendTinybar: bigint) {
    try {
      const whbar = await this.read<Address>(this.cfg.engine, engineAbi, "whbar");
      const router = await this.read<Address>(this.cfg.engine, engineAbi, "router");
      const out = await this.read<readonly bigint[]>(router, routerAbi, "getAmountsOut", [spendTinybar, [whbar, token]]);
      return out[1] ?? null;
    } catch (error) {
      if (error instanceof BaseError) return null;
      throw error;
    }
  }

  hbarBalance(account: Address) {
    return this.rpc.getBalance({ address: account });
  }

  /** Accepts 0.0.N or an EVM address; returns both forms from the mirror node. */
  async account(idOrAddress: string) {
    const info = await this.mirror<{ account: string; evm_address: Address }>(`/accounts/${idOrAddress}`);
    return { accountId: info.account, evmAddress: info.evm_address };
  }

  /** Polls the mirror node until the transaction's contract result is there. Throws after ~45 s. */
  async waitForResult(txId: string): Promise<ContractResult> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await this.mirror<ContractResult>(`/contracts/results/${txId}`);
      } catch (error) {
        if (!(error instanceof MirrorError) || error.status !== 404) throw error;
      }
      await sleep(1500);
    }
    throw new Error(`The mirror node has not recorded ${txId} after 45 s. Look it up on HashScan.`);
  }
}

/** The engine events in a contract result's logs, decoded. Logs of other contracts and unknown events are skipped. */
export function engineEvents(result: ContractResult, engine: Address) {
  return result.logs
    .filter((l) => l.address.toLowerCase() === engine.toLowerCase())
    .flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: engineAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return [{ name: e.eventName as string, args: e.args as unknown as Record<string, unknown> }];
      } catch {
        return [];
      }
    });
}
