import { useState } from "react";
import { SupplyChart } from "./SupplyChart";
import { ExternalLink, Panel } from "./ui";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useNow } from "~~/hooks/furnace/useNow";
import { fmtShare, fmtUnits, fmtUsdPrice } from "~~/utils/furnace/format";
import { hashscan } from "~~/utils/furnace/hedera";
import { supplySeries } from "~~/utils/furnace/supply";

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub: React.ReactNode }) => (
  <div>
    <dt className="text-xs font-medium text-base-content/60">{label}</dt>
    <dd className="m-0 mt-2 break-words font-mono text-2xl tabular-nums leading-none">{value}</dd>
    <dd className="m-0 mt-2 text-xs text-base-content/60">{sub}</dd>
  </div>
);

export function SupplyPanel({ snap }: { snap: Snapshot }) {
  const { engine, lv } = snap;
  const now = useNow(10_000);
  const info = engine.tokenInfo.data;
  const events = engine.events.data;
  const [picked, setPicked] = useState<number | null>(null);

  const decimals = lv.tokenDecimals;
  const symbol = info?.symbol ?? "tokens";
  const burned = lv.s.totalBurned;
  const max = info ? BigInt(info.max_supply) : undefined;
  const supply = info ? BigInt(info.total_supply) : lv.s.totalSupply;
  const points = info && events && now !== null ? supplySeries(events.events, info, now, events.complete) : undefined;
  const burnCount = points ? points.filter(p => p.burn).length : 0;
  const last = points
    ? points
        .map((p, i) => (p.burn ? i : -1))
        .filter(i => i >= 0)
        .pop()
    : undefined;
  const selected = picked !== null && points?.[picked]?.burn ? picked : last;
  const sel = points && selected !== undefined ? points[selected] : undefined;
  const ordinal = points && selected !== undefined ? points.slice(0, selected + 1).filter(p => p.burn).length : 0;

  return (
    <Panel
      id="supply-title"
      title="Supply"
      note={
        <>
          Mirror node, <ExternalLink href={hashscan.token(lv.s.token)}>{symbol} on HashScan</ExternalLink>
        </>
      }
    >
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[17rem_1fr] lg:gap-10">
        <dl className="m-0 grid grid-cols-1 content-start gap-7">
          <Stat
            label="Total supply"
            value={`${fmtUnits(supply, decimals, 2)}`}
            sub={max !== undefined ? `${symbol} of ${fmtUnits(max, decimals, 0)} max supply` : symbol}
          />
          <Stat
            label="Burned"
            value={fmtUnits(burned, decimals, 2)}
            sub={
              max !== undefined && max > 0n
                ? `${fmtShare(burned, max)} of max supply, ${burnCount} buyback${burnCount === 1 ? "" : "s"}`
                : `${symbol} burned`
            }
          />
          <Stat
            label="HBAR spent buying"
            value={fmtUnits(lv.s.totalSpentHbar, 8, 4)}
            sub={
              lv.s.priceUsd > 0n
                ? `Spot now ${fmtUsdPrice(lv.s.priceUsd)} per ${symbol}`
                : "Waiting for a fresh Chainlink answer"
            }
          />
        </dl>

        <div className="min-w-0">
          {points && max !== undefined && burnCount > 0 ? (
            <>
              <SupplyChart
                points={points}
                maxSupply={max}
                decimals={decimals}
                selected={selected!}
                onSelect={setPicked}
              />
              {sel?.burn && (
                <p className="m-0 mt-3 text-sm text-base-content/80" aria-live="polite">
                  <span className="font-mono tabular-nums">
                    Burn {ordinal} of {burnCount}
                  </span>
                  {": "}
                  {fmtUnits(sel.burn.hbar, 8, 4)} HBAR bought and burned {fmtUnits(sel.burn.tokens, decimals, 2)}{" "}
                  {symbol} at {fmtUsdPrice(sel.burn.priceUsd)}, leaving {fmtUnits(sel.supply, decimals, 2)}.{" "}
                  <ExternalLink href={hashscan.tx(sel.burn.hash)}>HashScan</ExternalLink>
                </p>
              )}
            </>
          ) : (
            <div className="grid h-full min-h-48 place-items-center rounded-box border border-dashed border-base-300 p-6 text-center">
              <p className="m-0 max-w-sm text-sm text-base-content/70">
                {points
                  ? "Nothing has burned yet. The supply line starts stepping down at the first buyback."
                  : "Reading the burn history from the mirror node."}
              </p>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
