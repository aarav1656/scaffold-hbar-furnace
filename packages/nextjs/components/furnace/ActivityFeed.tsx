import { useState } from "react";
import { ExternalLink, Panel } from "./ui";
import { type Hex, decodeErrorResult } from "viem";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useNow } from "~~/hooks/furnace/useNow";
import { ENGINE_ABI, SKIP_REASONS, SKIP_TEXT } from "~~/utils/furnace/constants";
import { fmtAgo, fmtBps, fmtDuration, fmtUnits, fmtUsd, fmtUsdPrice, shortAddress } from "~~/utils/furnace/format";
import { evmToEntityId, hashscan } from "~~/utils/furnace/hedera";
import { sourceLabel } from "~~/utils/furnace/revenue";
import type { EngineEvent } from "~~/utils/furnace/mirror";

type Args = Record<string, any>;

const LABELS: Record<string, string> = {
  Burned: "Burn",
  BuybackSkipped: "Buyback skipped",
  RunBooked: "Run booked",
  ScheduledRun: "Scheduled run",
  ScheduledRunFailed: "Run failed",
  BookingFailed: "Booking failed",
  AutomationStarted: "Automation on",
  AutomationStopped: "Automation off",
  RevenueReceived: "Revenue",
  RevenueTagged: "Revenue",
  Rearmed: "Schedule re-booked",
  Initialized: "Token created",
  PoolCreated: "Pool created",
  LiquiditySeeded: "Liquidity seeded",
  TeamAllocationClaimed: "Team claim",
  DailyBudgetSet: "Budget set",
  MaxImpactSet: "Impact cap set",
  PriceCeilingSet: "Ceiling set",
  SlippageSet: "Slippage set",
  MaxLotSet: "Lot size set",
  MinGapSet: "Gap set",
  MaxTwapDeviationSet: "Price bound set",
  OwnershipTransferred: "Ownership",
};

const FAILURES = new Set(["ScheduledRunFailed", "BookingFailed"]);

function revertText(reason: Hex): string {
  try {
    return decodeErrorResult({ abi: ENGINE_ABI, data: reason }).errorName;
  } catch {
    return reason.length > 10 ? `${reason.slice(0, 10)}…` : "no revert data";
  }
}

function describe(ev: EngineEvent, snap: Snapshot): React.ReactNode {
  const a = ev.args as Args;
  const d = snap.lv.tokenDecimals;
  const symbol = snap.engine.tokenInfo.data?.symbol ?? "tokens";

  switch (ev.name) {
    case "Burned":
      return `Spent ${fmtUnits(a.hbarIn, 8, 4)} HBAR buying ${fmtUnits(a.tokensBurned, d, 2)} ${symbol} at ${fmtUsdPrice(a.priceUsd)} (${fmtUnits(a.priceHbar, 8, 8)} HBAR) each, then burned them. Supply is now ${fmtUnits(a.supplyAfter, d, 2)}.`;
    case "BuybackSkipped":
      return `The run spent nothing. ${SKIP_TEXT[SKIP_REASONS[Number(a.reason)] ?? "None"]}`;
    case "RunBooked":
      return (
        <>
          Booked the next buyback for {new Date(Number(a.expiry) * 1000).toLocaleString()} on schedule{" "}
          <ExternalLink href={hashscan.schedule(a.schedule)}>{evmToEntityId(a.schedule)}</ExternalLink>
        </>
      );
    case "ScheduledRun":
      return a.tokensBurned > 0n
        ? `Scheduled run finished and burned ${fmtUnits(a.tokensBurned, d, 2)} ${symbol}.`
        : "Scheduled run finished without a burn.";
    case "ScheduledRunFailed":
      return `Scheduled run failed: ${revertText(a.reason)}. The next run is still booked.`;
    case "BookingFailed":
      return `Booking the next run failed with Hedera response code ${a.responseCode}.`;
    case "AutomationStarted":
      return `Automation started, one buyback every ${fmtDuration(Number(a.interval))}.`;
    case "AutomationStopped":
      return "Automation stopped and the pending schedule was deleted.";
    case "RevenueReceived":
      return `${shortAddress(a.from)} sent ${fmtUnits(a.amount, 8, 4)} HBAR to the engine.`;
    case "RevenueTagged":
      return `${shortAddress(a.from)} sent ${fmtUnits(a.amount, 8, 4)} HBAR to the engine as ${sourceLabel(a.source)}.`;
    case "Rearmed":
      return `${shortAddress(a.replacement)} was booked in place of an overdue schedule.`;
    case "Initialized":
      return `Created ${symbol} with a supply of ${fmtUnits(a.totalSupply, d, 0)}, ${fmtUnits(a.liquidityAllocation, d, 0)} of it reserved for the pool.`;
    case "PoolCreated":
      return `Created the SaucerSwap pool for ${symbol}. The pair fee was ${fmtUnits(a.feeTinybar, 8, 4)} HBAR.`;
    case "LiquiditySeeded":
      return `Seeded the pool with ${fmtUnits(a.tokenAmount, d, 2)} ${symbol} and ${fmtUnits(a.hbarAmount, 8, 4)} HBAR. The LP tokens stay in the engine.`;
    case "TeamAllocationClaimed":
      return `${fmtUnits(a.amount, d, 2)} ${symbol} of team allocation went to ${shortAddress(a.to)}.`;
    case "DailyBudgetSet":
      return `Daily budget set to ${fmtUsd(a.dailyBudgetUsd)}.`;
    case "MaxImpactSet":
      return `Max price impact set to ${fmtBps(a.maxImpactBps)}.`;
    case "PriceCeilingSet":
      return a.priceCeilingUsd === 0n
        ? "Price ceiling removed."
        : `Price ceiling set to ${fmtUsdPrice(a.priceCeilingUsd)}.`;
    case "SlippageSet":
      return `Swap slippage set to ${fmtBps(a.slippageBps)}.`;
    case "MaxLotSet":
      return a.maxLotUsd === 0n ? "Lot cap removed." : `Lot size set to ${fmtUsd(a.maxLotUsd)} per buyback.`;
    case "MinGapSet":
      return a.minGapSeconds === 0n
        ? "Minimum gap between buybacks removed."
        : `Minimum gap between buybacks set to ${fmtDuration(Number(a.minGapSeconds))}.`;
    case "MaxTwapDeviationSet":
      return `Price bound set: no buy while the pool is more than ${fmtBps(a.maxTwapDeviationBps)} above its average.`;
    case "OwnershipTransferred":
      return `Ownership moved to ${shortAddress(a.newOwner)}.`;
    default:
      return ev.name;
  }
}

const PAGE = 20;

export function ActivityFeed({ snap }: { snap: Snapshot }) {
  const events = snap.engine.events;
  const now = useNow(10_000);
  const [shown, setShown] = useState(PAGE);
  const list = events.data?.events ?? [];

  return (
    <Panel id="activity-title" title="Activity" note="Decoded from the Hedera mirror node, refreshed every 15s">
      {events.isLoading && <p className="m-0 mt-6 text-sm text-base-content/60">Reading the engine logs.</p>}
      {events.isError && (
        <p className="m-0 mt-6 text-sm text-error" role="alert">
          The mirror node did not answer.{" "}
          <button type="button" className="link" onClick={() => events.refetch()}>
            Retry
          </button>
        </p>
      )}
      {events.data && list.length === 0 && (
        <p className="m-0 mt-6 text-sm text-base-content/70">
          The engine has not logged anything yet. Its first event lands here the moment it is created.
        </p>
      )}
      {list.length > 0 && (
        <ul className="m-0 mt-4 list-none divide-y divide-base-300 p-0">
          {list.slice(0, shown).map(ev => {
            const failed = FAILURES.has(ev.name);
            return (
              <li
                key={ev.id}
                className="flex flex-col gap-1 py-3 sm:grid sm:grid-cols-[6rem_9.5rem_1fr_auto] sm:items-baseline sm:gap-x-4"
              >
                <time
                  className="font-mono text-xs tabular-nums text-base-content/60"
                  dateTime={new Date(ev.at * 1000).toISOString()}
                  title={new Date(ev.at * 1000).toLocaleString()}
                >
                  {now === null ? "" : fmtAgo(Math.max(0, now - ev.at))}
                </time>
                <span
                  className={`font-mono text-xs ${failed ? "text-error" : ev.name === "Burned" ? "font-medium text-primary" : "text-base-content/70"}`}
                >
                  {LABELS[ev.name] ?? ev.name}
                </span>
                <span className={`min-w-0 break-words text-sm ${failed ? "text-error" : ""}`}>
                  {describe(ev, snap)}
                </span>
                <a className="link link-primary text-xs" href={hashscan.tx(ev.hash)} target="_blank" rel="noreferrer">
                  HashScan
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > shown && (
        <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setShown(n => n + PAGE)}>
          Show older ({list.length - shown} more)
        </button>
      )}
    </Panel>
  );
}
