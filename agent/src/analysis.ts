import { WEIBAR_PER_TINYBAR, fmt8 } from "./units";

/** FurnaceEngine.Skip in declaration order: the index is what previewBuyback() and BuybackSkipped carry. */
export const SKIPS = [
  ["None", "Nothing blocks a buyback: it would spend and burn."],
  ["NotReady", "The pool has no liquidity yet."],
  ["NoFunds", "The engine holds no HBAR above its fuel reserve."],
  ["BudgetSpent", "The daily USD budget is spent; it resets 24 hours after the window opened."],
  ["PriceCeiling", "The token trades at or above the USD price ceiling, so the engine does not buy."],
  ["ImpactCap", "The pool is too shallow: even the minimum spend would move the price past the impact cap."],
  ["TooSoon", "The minimum gap since the last buy has not passed."],
  ["LotCap", "The per-buy USD lot cap is below the minimum spend."],
  ["NoTwap", "The engine has no price snapshot yet, so there is no average price to check against."],
  ["TwapWindow", "The price snapshot is younger than the 15 minute minimum window."],
  ["TwapDeviation", "The pool's spot price sits above its time-weighted average by more than the allowed deviation, which blocks a buy into a spike."],
] as const;

export function skipInfo(code: number | bigint): { code: number; name: string; meaning: string } {
  const entry = SKIPS[Number(code)];
  if (!entry) throw new Error(`unknown Skip code ${code}`);
  return { code: Number(code), name: entry[0], meaning: entry[1] };
}

/** previewBuyback() reverts while the Chainlink answer is stale, so a stale oracle is its own preview outcome. */
export type Preview = { ok: true; skip: number; spend: bigint } | { ok: false; reason: string };

export function previewInfo(p: Preview): { wouldSpend: boolean; skip: { code: number; name: string; meaning: string }; spend: bigint } {
  if (!p.ok)
    return { wouldSpend: false, skip: { code: -1, name: p.reason, meaning: "The Chainlink HBAR/USD feed is stale or not positive, so the engine cannot price a buy and a buyback would revert." }, spend: 0n };
  return { wouldSpend: p.skip === 0, skip: skipInfo(p.skip), spend: p.spend };
}

export type NextRun = {
  automation: "on" | "off";
  intervalSeconds: number;
  pendingSchedule: string | null;
  nextRunAt: number | null;
  nextRunAtIso: string | null;
  secondsUntil: number | null;
  /** off: no automation. scheduled: a run is booked. past_due: booked, not executed yet. orphaned: on with nothing booked. */
  status: "off" | "scheduled" | "past_due" | "orphaned";
  /** True when rearm() would be accepted: automation on and the booked run is missing or more than the grace period overdue. */
  rearmable: boolean;
};

const ZERO = /^0x0{40}$/i;

export function nextRun(interval: bigint, pending: string, nextRunAt: bigint, now: number, rearmGrace: bigint): NextRun {
  if (interval === 0n)
    return { automation: "off", intervalSeconds: 0, pendingSchedule: null, nextRunAt: null, nextRunAtIso: null, secondsUntil: null, status: "off", rearmable: false };
  if (ZERO.test(pending))
    return { automation: "on", intervalSeconds: Number(interval), pendingSchedule: null, nextRunAt: null, nextRunAtIso: null, secondsUntil: null, status: "orphaned", rearmable: true };
  const at = Number(nextRunAt);
  const until = at - now;
  return {
    automation: "on",
    intervalSeconds: Number(interval),
    pendingSchedule: pending,
    nextRunAt: at,
    nextRunAtIso: new Date(at * 1000).toISOString(),
    secondsUntil: until,
    status: until > 0 ? "scheduled" : "past_due",
    rearmable: now > at + Number(rearmGrace),
  };
}

export type FuelRunway = {
  fuelHbar: string;
  reservationHbar: string;
  lastRunCostHbar: string | null;
  runsCovered: number;
  daysCovered: number | null;
  basis: "last-run-cost" | "reservation-only";
};

/**
 * Scheduled runs the engine's protected fuel pays for. Fuel is the smaller of the engine's balance and its
 * fuelReserve (buybacks never touch the reserve). Each run needs the whole gas reservation (scheduledGas x gas
 * price) present and is charged its real fee: runs = (fuel - reservation) / fee + 1.
 */
export function fuelRunway(balanceTinybar: bigint, fuelReserveTinybar: bigint, scheduledGas: bigint, gasPriceWeibar: bigint, lastRunFeeTinybar: bigint | null, intervalSeconds: bigint): FuelRunway {
  const fuel = balanceTinybar < fuelReserveTinybar ? balanceTinybar : fuelReserveTinybar;
  const reservation = (scheduledGas * gasPriceWeibar) / WEIBAR_PER_TINYBAR;
  let runs = 0n;
  if (reservation > 0n && fuel >= reservation) runs = lastRunFeeTinybar && lastRunFeeTinybar > 0n ? (fuel - reservation) / lastRunFeeTinybar + 1n : fuel / reservation;
  return {
    fuelHbar: fmt8(fuel),
    reservationHbar: fmt8(reservation),
    lastRunCostHbar: lastRunFeeTinybar === null ? null : fmt8(lastRunFeeTinybar),
    runsCovered: Number(runs),
    daysCovered: intervalSeconds === 0n ? null : Number((runs * intervalSeconds * 100n) / 86_400n) / 100,
    basis: lastRunFeeTinybar && lastRunFeeTinybar > 0n ? "last-run-cost" : "reservation-only",
  };
}

export type BurnEvent = { timestamp: string; tokensBurned: bigint; hbarIn: bigint };

export type BurnSplit = {
  network: { burns: number; tokensBurned: bigint; hbarSpent: bigint };
  manual: { burns: number; tokensBurned: bigint; hbarSpent: bigint };
};

/**
 * A burn is the network's when the same transaction (same consensus timestamp) also emitted ScheduledRun, which
 * only the engine's own Hedera Schedule Service call does. Every other Burned event came from a direct buyback()
 * call: the owner, or anyone once a minimum gap is set.
 */
export function splitBurns(burned: readonly BurnEvent[], scheduledRunTimestamps: ReadonlySet<string>): BurnSplit {
  const out: BurnSplit = { network: { burns: 0, tokensBurned: 0n, hbarSpent: 0n }, manual: { burns: 0, tokensBurned: 0n, hbarSpent: 0n } };
  for (const b of burned) {
    const side = scheduledRunTimestamps.has(b.timestamp) ? out.network : out.manual;
    side.burns += 1;
    side.tokensBurned += b.tokensBurned;
    side.hbarSpent += b.hbarIn;
  }
  return out;
}

/** The policy settings set_policy can change, with the contract's own bounds (FurnaceEngine constants). */
export type PolicySetting = keyof typeof POLICY;
export const POLICY = {
  dailyBudgetUsd: { kind: "usd", min: 0n, max: (1n << 64n) - 1n, what: "USD the engine may spend per 24 hours (0 pauses buying)" },
  priceCeilingUsd: { kind: "usd", min: 0n, max: (1n << 64n) - 1n, what: "USD price per whole token above which the engine never buys (0 means no ceiling)" },
  maxLotUsd: { kind: "usd", min: 0n, max: (1n << 64n) - 1n, minNonZero: 10_000_000n, what: "most one buy may spend in USD (0 means no cap, otherwise at least $0.10)" },
  maxImpactBps: { kind: "int", min: 1n, max: 1000n, what: "most one buy may move the pool price, in basis points" },
  slippageBps: { kind: "int", min: 0n, max: 1000n, what: "most a swap may return below the router quote, in basis points" },
  minGapSeconds: { kind: "int", min: 0n, max: 86_400n, what: "seconds between buys that spent; above 0 anyone may trigger a buy" },
  maxTwapDeviationBps: { kind: "int", min: 50n, max: 2000n, what: "how far spot may sit above the time-weighted average before a buy is refused, in basis points" },
} as const;

export const POLICY_NAMES = Object.keys(POLICY) as PolicySetting[];

/** Validates a policy value against the contract's bounds and returns the integer the setter takes. Throws a readable reason. */
export function policyArg(setting: PolicySetting, value: string): bigint {
  const spec = POLICY[setting];
  const text = value.trim();
  let n: bigint;
  if (spec.kind === "usd") {
    if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${setting} is USD with at most 8 decimals, got "${value}"`);
    const [whole, frac = ""] = text.split(".");
    n = BigInt(whole!) * 10n ** 8n + BigInt(frac.padEnd(8, "0"));
  } else {
    if (!/^\d+$/.test(text)) throw new Error(`${setting} is a whole number, got "${value}"`);
    n = BigInt(text);
  }
  if (n < spec.min || n > spec.max) throw new Error(`${setting} must be between ${spec.kind === "usd" ? fmt8(spec.min) : spec.min} and ${spec.kind === "usd" ? fmt8(spec.max) : spec.max}, got ${value}`);
  if ("minNonZero" in spec && n !== 0n && n < spec.minNonZero) throw new Error(`${setting} must be 0 or at least $${fmt8(spec.minNonZero)}, got ${value}`);
  return n;
}

export const setterName = (setting: PolicySetting) => `set${setting[0]!.toUpperCase()}${setting.slice(1)}`;
