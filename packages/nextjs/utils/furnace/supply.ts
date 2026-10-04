import type { EngineEvent, TokenInfo } from "./mirror";
import type { Hex } from "viem";

export type Burn = { tokens: bigint; hbar: bigint; hash: Hex; priceUsd: bigint };
export type SupplyPoint = { t: number; supply: bigint; burn?: Burn };

/**
 * The token's supply over time as the points of a step line: creation, then each Burned event's `supplyAfter` at its
 * consensus time, then the mirror node's current total. `complete` false means older events were cut off, so the
 * creation point is left out rather than drawn from a supply the events cannot confirm.
 */
export function supplySeries(events: EngineEvent[], info: TokenInfo, now: number, complete: boolean): SupplyPoint[] {
  const burns = events
    .filter(e => e.name === "Burned")
    .map((e): SupplyPoint => {
      const a = e.args as { hbarIn: bigint; tokensBurned: bigint; priceUsd: bigint; supplyAfter: bigint };
      return {
        t: Number(e.timestamp),
        supply: a.supplyAfter,
        burn: { tokens: a.tokensBurned, hbar: a.hbarIn, hash: e.hash, priceUsd: a.priceUsd },
      };
    })
    .sort((x, y) => x.t - y.t);
  const points: SupplyPoint[] = complete
    ? [{ t: Number(info.created_timestamp), supply: BigInt(info.initial_supply) }]
    : [];
  points.push(...burns);
  const last = points[points.length - 1];
  points.push({ t: Math.max(now, last ? last.t : now), supply: BigInt(info.total_supply) });
  return points;
}
