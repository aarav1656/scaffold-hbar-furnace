import { ENGINE_ABI } from "./constants";
import { evmToEntityId } from "./hedera";
import { type Address, type Hex, decodeEventLog } from "viem";

export const MIRROR_URL = process.env.NEXT_PUBLIC_HEDERA_TESTNET_MIRROR_URL || "https://testnet.mirrornode.hedera.com";

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Mirror node answered ${status} for ${path}`);
  }
}

export async function mirrorGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MIRROR_URL}/api/v1${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new MirrorError(res.status, path);
  return (await res.json()) as T;
}

export type Association = "associated" | "auto" | "needs";

/**
 * Whether `account` can receive `token`. Throws on any lookup failure so the caller can show "unknown"
 * rather than guess: an unreadable answer is never reported as associated.
 */
export async function fetchAssociation(account: Address, token: Address): Promise<Association> {
  const tokenId = evmToEntityId(token);
  const rel = await mirrorGet<{ tokens: { token_id: string }[] }>(`/accounts/${account}/tokens?token.id=${tokenId}`);
  if (rel.tokens.some(t => t.token_id === tokenId)) return "associated";
  const info = await mirrorGet<{ max_automatic_token_associations: number }>(`/accounts/${account}`);
  return info.max_automatic_token_associations === -1 ? "auto" : "needs";
}

type ContractResult = { result: string; call_result: Hex | null };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A call's own outcome on the mirror node. A receipt only says the transaction ran; HTS calls such as
 * `associate()` report failure as a returned response code, which lives in `call_result`.
 */
export async function waitForContractResult(hash: Hex): Promise<ContractResult> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await mirrorGet<ContractResult>(`/contracts/results/${hash}`);
    } catch (error) {
      if (!(error instanceof MirrorError) || error.status !== 404) throw error;
    }
    await sleep(1500);
  }
  throw new Error("The mirror node has not recorded the transaction yet. Look it up on HashScan.");
}

export type MirrorLog = {
  data: Hex;
  topics: Hex[];
  index: number;
  timestamp: string;
  transaction_hash: Hex;
};

export type EngineEvent = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Consensus time, unix seconds. */
  at: number;
  /** Consensus timestamp as the mirror node prints it, seconds.nanoseconds. */
  timestamp: string;
  hash: Hex;
};

/** Null for a log the engine ABI cannot decode: it is not one of the engine's events, so it gets no row. */
function decodeEngineLog(log: MirrorLog): EngineEvent | null {
  try {
    const decoded = decodeEventLog({ abi: ENGINE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return {
      id: `${log.transaction_hash}-${log.index}`,
      name: decoded.eventName,
      args: (decoded.args ?? {}) as Record<string, unknown>,
      at: Number(log.timestamp.split(".")[0]),
      timestamp: log.timestamp,
      hash: log.transaction_hash,
    };
  } catch {
    return null;
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

/**
 * Every engine event, newest first, paged through the mirror node (the JSON-RPC getLogs on hashio is range-limited,
 * the mirror node is not). The supply chart and the activity feed both read this one list. `complete` is false when
 * the page cap cut the history short.
 */
export async function fetchEngineEvents(engine: Address): Promise<{ events: EngineEvent[]; complete: boolean }> {
  const events: EngineEvent[] = [];
  let path: string | null = `/contracts/${engine}/results/logs?order=desc&limit=${PAGE_SIZE}`;
  for (let page = 0; page < MAX_PAGES && path; page++) {
    const res: { logs: MirrorLog[]; links?: { next: string | null } } = await mirrorGet(path);
    events.push(...res.logs.flatMap(log => decodeEngineLog(log) ?? []));
    path = res.links?.next ? res.links.next.replace(/^\/api\/v1/, "") : null;
  }
  return { events, complete: path === null };
}

export type TokenInfo = {
  token_id: string;
  name: string;
  symbol: string;
  decimals: string;
  total_supply: string;
  max_supply: string;
  initial_supply: string;
  supply_type: "FINITE" | "INFINITE";
  treasury_account_id: string;
  /** Consensus time the token was created at, seconds.nanoseconds. */
  created_timestamp: string;
  admin_key: unknown;
  wipe_key: unknown;
  freeze_key: unknown;
  pause_key: unknown;
  kyc_key: unknown;
  supply_key: unknown;
  fee_schedule_key: unknown;
};

/** Supply and key facts of an HTS token, straight from the mirror node. */
export const fetchTokenInfo = (token: Address) => mirrorGet<TokenInfo>(`/tokens/${evmToEntityId(token)}`);

/**
 * What the engine's most recent scheduled run actually cost it, in tinybar, or null if it has not run. A scheduled
 * run is its own transaction on the mirror node, found by the consensus timestamp of its ScheduledRun log.
 */
export async function fetchRunFee(timestamp: string): Promise<bigint | null> {
  const { transactions } = await mirrorGet<{ transactions: { charged_tx_fee: number }[] }>(
    `/transactions?timestamp=${timestamp}`,
  );
  return transactions.length > 0 ? BigInt(transactions[0].charged_tx_fee) : null;
}
