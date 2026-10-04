import { ExternalLink, Panel, Row } from "./ui";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useNow } from "~~/hooks/furnace/useNow";
import { fmtAgo, fmtBps, fmtDuration, fmtShare, fmtUnits, fmtUsd, fmtUsdPrice } from "~~/utils/furnace/format";
import { hashscan } from "~~/utils/furnace/hedera";

const BUDGET_WINDOW = 86_400;

/** A horizontal gauge: `fill` of `of`, in the ember colour, with the empty track behind it. */
const Gauge = ({ fill, of, label }: { fill: bigint; of: bigint; label: string }) => {
  const pct = of > 0n ? Number((fill * 10_000n) / of) / 100 : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-base-300"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(pct))}
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
};

export function PolicyPanel({ snap }: { snap: Snapshot }) {
  const { engine, cfg, lv } = snap;
  const now = useNow(5000);
  const { s } = lv;
  const symbol = engine.tokenInfo.data?.symbol ?? "token";
  const hbarUsd = s.hbarUsd;
  const stale = hbarUsd === 0n;
  const toHbar = (usd8: bigint) => (hbarUsd > 0n ? (usd8 * 100_000_000n) / hbarUsd : undefined);
  const budgetLeftHbar = toHbar(s.budgetLeftUsd);
  const age = lv.feed && now !== null ? Math.max(0, now - lv.feed.updatedAt) : undefined;
  const resetsIn = now !== null && s.spentTodayUsd > 0n ? lv.windowStart + BUDGET_WINDOW - now : undefined;
  const ceiling = lv.priceCeilingUsd;

  return (
    <Panel id="policy-title" title="Policy" note="Set by the owner, enforced by the contract on every run">
      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm text-base-content/70">Spent today</span>
          <span className="font-mono text-sm tabular-nums">
            {fmtUsd(s.spentTodayUsd)} of {fmtUsd(lv.dailyBudgetUsd)}
          </span>
        </div>
        <div className="mt-2">
          <Gauge fill={s.spentTodayUsd} of={lv.dailyBudgetUsd} label="Share of the daily USD budget already spent" />
        </div>
        <p className="m-0 mt-2 text-xs text-base-content/60">
          {resetsIn !== undefined && resetsIn > 0
            ? `The 24h window rolls over in ${fmtDuration(resetsIn)}.`
            : "The next buyback opens a fresh 24h window."}
        </p>
      </div>

      <dl className="m-0 mt-3">
        <Row
          label="Daily budget"
          note={
            toHbar(lv.dailyBudgetUsd) !== undefined
              ? `${fmtUnits(toHbar(lv.dailyBudgetUsd)!, 8, 2)} HBAR at the Chainlink price`
              : undefined
          }
        >
          {fmtUsd(lv.dailyBudgetUsd)}
        </Row>
        <Row label="Budget left today">
          {fmtUsd(s.budgetLeftUsd, 4)}
          {budgetLeftHbar !== undefined ? ` · ${fmtUnits(budgetLeftHbar, 8, 2)} HBAR` : ""}
        </Row>
        <Row label="Max price impact" note="Per buyback. A run is cut to the size that moves the pool no further.">
          {fmtBps(lv.maxImpactBps)}
        </Row>
        <Row
          label={`${symbol} price now`}
          note={
            s.reserveToken > 0n
              ? `Pool holds ${fmtUnits(s.reserveHbar, 8, 2)} HBAR and ${fmtUnits(s.reserveToken, lv.tokenDecimals, 2)} ${symbol}`
              : "The pool has no liquidity yet"
          }
        >
          {s.priceUsd > 0n ? fmtUsdPrice(s.priceUsd) : stale ? "Unavailable" : "n/a"}
          {s.priceHbar > 0n ? ` · ${fmtUnits(s.priceHbar, 8, 8)} HBAR` : ""}
        </Row>
        <Row
          label="Price ceiling"
          note={
            ceiling === 0n
              ? "No ceiling is set, so only the budget and the impact cap bound a run."
              : s.priceUsd >= ceiling
                ? "The price is at the ceiling, so buybacks pause until it falls."
                : s.priceUsd > 0n
                  ? `The price sits at ${fmtShare(s.priceUsd, ceiling, 1)} of the ceiling.`
                  : undefined
          }
        >
          {ceiling === 0n ? "None" : fmtUsdPrice(ceiling)}
        </Row>
        <Row label="Swap slippage" note="Lowest fill the router may return against its own quote.">
          {fmtBps(lv.slippageBps)}
        </Row>
        <Row
          label="HBAR / USD"
          note={
            stale ? (
              <span className="text-error">
                Chainlink is older than {fmtDuration(cfg.maxOracleAge)}. Buybacks wait for its next update.
              </span>
            ) : age !== undefined ? (
              <>
                <ExternalLink href={hashscan.contract(cfg.feed)}>Chainlink</ExternalLink>, updated {fmtAgo(age)}
              </>
            ) : undefined
          }
        >
          {hbarUsd > 0n ? fmtUsd(hbarUsd, 4) : lv.feed ? fmtUsd(lv.feed.answer, 4) : "Unreadable"}
        </Row>
      </dl>
      {ceiling > 0n && s.priceUsd > 0n && (
        <div className="mt-2">
          <Gauge fill={s.priceUsd} of={ceiling} label="Token price as a share of the USD ceiling" />
        </div>
      )}
    </Panel>
  );
}
