import type { Address } from "viem";
import { type FuelRunway, type NextRun, fuelRunway, nextRun, previewInfo } from "./analysis";
import type { BurnLedger, RawState } from "./chain";
import type { EngineConfig } from "./config";
import { linkBuilder } from "./links";
import { fmt8, fmtUnits } from "./units";

const hbarFromUsd = (usd: bigint, hbarUsd: bigint) => (hbarUsd === 0n ? null : fmt8((usd * 10n ** 8n) / hbarUsd));

export function policyView(p: RawState["policy"]) {
  return {
    dailyBudgetUsd: fmt8(p.dailyBudgetUsd),
    maxImpactBps: Number(p.maxImpactBps),
    priceCeilingUsd: p.priceCeilingUsd === 0n ? null : fmt8(p.priceCeilingUsd),
    slippageBps: Number(p.slippageBps),
    maxLotUsd: p.maxLotUsd === 0n ? null : fmt8(p.maxLotUsd),
    minGapSeconds: Number(p.minGapSeconds),
    maxTwapDeviationBps: Number(p.maxTwapDeviationBps),
    minSpendHbar: fmt8(p.minSpend),
    fuelReserveHbar: fmt8(p.fuelReserve),
    anyoneMayTrigger: p.minGapSeconds > 0n,
  };
}

export type FurnaceState = {
  engine: Address;
  owner: Address;
  token: { id: Address; symbol: string; decimals: number; totalSupply: string; teamUnclaimed: string; liquidityUnseeded: string };
  burned: {
    totalBurned: string;
    totalSpentHbar: string;
    percentOfSupplyBurned: string;
    burns: { network: number; manual: number } | null;
    byNetwork: { tokens: string; hbar: string } | null;
    byManual: { tokens: string; hbar: string } | null;
    mirrorReconciled: boolean | null;
  };
  budget: { dailyUsd: string; spentTodayUsd: string; leftUsd: string; leftHbar: string | null; hbarUsd: string | null; oracle: "fresh" | "stale" };
  engineBalanceHbar: string;
  spendableHbar: string;
  pool: { priceHbar: string; priceUsd: string; reserveHbar: string; reserveToken: string };
  policy: ReturnType<typeof policyView>;
  nextBuyAt: number | null;
  nextBurn: NextRun;
  fuel: FuelRunway;
  buyback: { wouldSpend: boolean; skip: ReturnType<typeof previewInfo>["skip"]; spendHbar: string };
  links: Record<string, string>;
};

/** Turns raw chain reads into the structured result of get_furnace_state. Pure: no network, no clock. */
export function shapeState(raw: RawState, ledger: BurnLedger | null, cfg: EngineConfig): FurnaceState {
  const L = linkBuilder(cfg.hashscanUrl);
  const s = raw.status;
  const d = raw.tokenDecimals;
  const stale = s.hbarUsd === 0n;
  const spendable = s.balance > raw.policy.fuelReserve ? s.balance - raw.policy.fuelReserve : 0n;
  const pct = s.totalSupply + s.totalBurned === 0n ? 0n : (s.totalBurned * 10_000n) / (s.totalSupply + s.totalBurned);
  const split = ledger?.split;
  const side = (x: { tokensBurned: bigint; hbarSpent: bigint }) => ({ tokens: fmtUnits(x.tokensBurned, d), hbar: fmt8(x.hbarSpent) });
  return {
    engine: raw.engine,
    owner: raw.owner,
    token: {
      id: s.token,
      symbol: raw.tokenSymbol,
      decimals: d,
      totalSupply: fmtUnits(s.totalSupply, d),
      teamUnclaimed: fmtUnits(s.teamUnclaimed, d),
      liquidityUnseeded: fmtUnits(s.liquidityUnseeded, d),
    },
    burned: {
      totalBurned: fmtUnits(s.totalBurned, d),
      totalSpentHbar: fmt8(s.totalSpentHbar),
      percentOfSupplyBurned: `${Number(pct) / 100}`,
      burns: split ? { network: split.network.burns, manual: split.manual.burns } : null,
      byNetwork: split ? side(split.network) : null,
      byManual: split ? side(split.manual) : null,
      mirrorReconciled: ledger ? ledger.reconciled : null,
    },
    budget: {
      dailyUsd: fmt8(raw.policy.dailyBudgetUsd),
      spentTodayUsd: fmt8(s.spentTodayUsd),
      leftUsd: fmt8(s.budgetLeftUsd),
      leftHbar: hbarFromUsd(s.budgetLeftUsd, s.hbarUsd),
      hbarUsd: stale ? null : fmt8(s.hbarUsd),
      oracle: stale ? "stale" : "fresh",
    },
    engineBalanceHbar: fmt8(s.balance),
    spendableHbar: fmt8(spendable),
    pool: { priceHbar: fmt8(s.priceHbar), priceUsd: fmt8(s.priceUsd), reserveHbar: fmt8(s.reserveHbar), reserveToken: fmtUnits(s.reserveToken, d) },
    policy: policyView(raw.policy),
    nextBuyAt: s.nextBuyAt === 0n ? null : Number(s.nextBuyAt),
    nextBurn: nextRun(s.interval, s.pendingSchedule, s.nextRunAt, raw.nowSeconds, raw.rearmGrace),
    fuel: fuelRunway(s.balance, raw.policy.fuelReserve, raw.policy.scheduledGas, raw.gasPriceWeibar, ledger?.lastRunFeeTinybar ?? null, s.interval),
    buyback: ((p) => ({ wouldSpend: p.wouldSpend, skip: p.skip, spendHbar: fmt8(p.spend) }))(previewInfo(raw.preview)),
    links: {
      engine: L.contract(raw.engine),
      token: L.token(s.token),
      pair: L.contract(s.pair),
      owner: L.account(raw.owner),
      ...(/^0x0{40}$/i.test(s.pendingSchedule) ? {} : { pendingSchedule: L.schedule(s.pendingSchedule) }),
    },
  };
}

export function describeState(s: FurnaceState): string {
  const b = s.burned;
  const lines = [
    `Furnace ${s.engine}: ${b.totalBurned} ${s.token.symbol} burned (${b.percentOfSupplyBurned}% of the original supply) for ${b.totalSpentHbar} HBAR, ${s.token.totalSupply} left in supply.`,
    b.burns ? `${b.burns.network + b.burns.manual} burns: ${b.burns.network} by the network's schedule, ${b.burns.manual} by direct calls.` : "",
    `Budget left today: $${s.budget.leftUsd} of $${s.budget.dailyUsd}${s.budget.leftHbar ? ` (${s.budget.leftHbar} HBAR)` : ""}.${s.budget.oracle === "stale" ? " The Chainlink HBAR/USD feed is stale, so buybacks are paused." : ""}`,
    s.buyback.wouldSpend ? `A buyback now would spend ${s.buyback.spendHbar} HBAR.` : `A buyback now would be skipped: ${s.buyback.skip.name}. ${s.buyback.skip.meaning}`,
  ];
  const n = s.nextBurn;
  lines.push(
    n.status === "off"
      ? "Automation is off."
      : n.status === "orphaned"
        ? "Automation is on but no run is booked: rearm_automation re-books it."
        : n.status === "past_due"
          ? `The booked run is ${-n.secondsUntil!}s past due.${n.rearmable ? " It is past the grace period: rearm_automation re-books it." : ""}`
          : `Next scheduled burn in ${Math.round(n.secondsUntil! / 60)} min (${n.nextRunAtIso}).`,
  );
  lines.push(`Fuel ${s.fuel.fuelHbar} HBAR covers about ${s.fuel.runsCovered} scheduled runs${s.fuel.daysCovered === null ? "" : ` (${s.fuel.daysCovered} days)`}.`);
  return lines.filter(Boolean).join("\n");
}
