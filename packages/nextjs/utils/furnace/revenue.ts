import type { EngineEvent } from "./mirror";
import { type Hex, hexToString } from "viem";

export const UNTAGGED = "Untagged transfers";

export type RevenueSource = { source: string; amount: bigint; deposits: number };

/** A bytes32 label such as `bytes32("swap-fees")` as text; anything that is not printable ASCII stays hex. */
export function sourceLabel(source: Hex): string {
  const text = hexToString(source, { size: 32 }).replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(text) ? text : source;
}

/** Revenue the engine has received, totalled by source: tagged deposits by label, plain transfers as one stream. */
export function revenueBySource(events: EngineEvent[]): RevenueSource[] {
  const totals = new Map<string, RevenueSource>();
  const add = (source: string, amount: bigint) => {
    const row = totals.get(source) ?? { source, amount: 0n, deposits: 0 };
    row.amount += amount;
    row.deposits += 1;
    totals.set(source, row);
  };
  for (const ev of events) {
    const a = ev.args as { source?: Hex; amount?: bigint };
    if (ev.name === "RevenueReceived") add(UNTAGGED, a.amount ?? 0n);
    else if (ev.name === "RevenueTagged" && a.source) add(sourceLabel(a.source), a.amount ?? 0n);
  }
  return [...totals.values()].sort((x, y) => (x.amount === y.amount ? 0 : x.amount > y.amount ? -1 : 1));
}
