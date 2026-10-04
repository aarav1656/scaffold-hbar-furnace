import { useState } from "react";
import { TxSteps } from "./TxSteps";
import { WalletGate } from "./WalletGate";
import { ExternalLink, Panel } from "./ui";
import { formatUnits } from "viem";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useTx, useWalletReady } from "~~/hooks/furnace/useTx";
import { ENGINE_ADDRESS, GAS_FLOOR, WEIBAR_PER_TINYBAR } from "~~/utils/furnace/constants";
import { fmtShare, fmtUnits, parseAmount, shortAddress } from "~~/utils/furnace/format";
import { hashscan } from "~~/utils/furnace/hedera";
import { revenueBySource } from "~~/utils/furnace/revenue";

/** Anyone can point revenue at the engine: a plain HBAR transfer to its address. */
export function RevenuePanel({ snap }: { snap: Snapshot }) {
  const { engine, lv } = snap;
  const ready = useWalletReady();
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const sources = revenueBySource(engine.events.data?.events ?? []);
  const total = sources.reduce((sum, row) => sum + row.amount, 0n);

  const tiny = parseAmount(amount, 8);
  const weibar = tiny === null ? null : tiny * WEIBAR_PER_TINYBAR;
  const walletBalance = engine.wallet.data?.value;
  const gasPrice = engine.gasPrice.data;
  const reserve = gasPrice !== undefined ? GAS_FLOOR.revenue * gasPrice : undefined;
  const maxTiny =
    walletBalance !== undefined && reserve !== undefined && walletBalance > reserve
      ? (walletBalance - reserve) / WEIBAR_PER_TINYBAR
      : 0n;

  const problem = (() => {
    if (amount && tiny === null) return "Enter an HBAR amount with at most 8 decimals.";
    if (tiny === 0n) return "Enter an amount above zero.";
    if (weibar !== null && walletBalance !== undefined && reserve !== undefined && weibar + reserve > walletBalance) {
      return `Your balance is short once the gas reserve of about ${fmtUnits(reserve, 18, 3)} HBAR is set aside.`;
    }
    return null;
  })();
  const canSend = !!tiny && !problem && weibar !== null && !tx.running;

  const submit = async () => {
    if (!canSend || weibar === null) return;
    setSent(`Send ${amount} HBAR to the engine`);
    if (await tx.run([{ id: "revenue", send: () => tx.sendValue(ENGINE_ADDRESS, weibar) }])) setAmount("");
  };

  return (
    <Panel id="revenue-title" title="Send revenue">
      <p className="m-0 mt-1 max-w-md text-sm text-base-content/70">
        Anyone can point HBAR at the engine: a plain transfer to its address. What sits above the{" "}
        {fmtUnits(lv.s.fuel, 8, 2)} HBAR fuel reserve is spent by the next run, inside the budget.
      </p>

      <label className="mt-5 flex flex-col gap-2">
        <span className="flex items-baseline justify-between text-sm font-medium">
          Amount
          <span className="text-xs font-normal text-base-content/60">
            Wallet{" "}
            <span className="font-mono tabular-nums">
              {walletBalance !== undefined ? `${fmtUnits(walletBalance, 18, 4)} HBAR` : "n/a"}
            </span>
          </span>
        </span>
        <div className="join w-full">
          <input
            inputMode="decimal"
            className="input join-item w-full min-w-0 font-mono tabular-nums"
            placeholder="0.0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            aria-invalid={!!amount && tiny === null}
          />
          <button
            type="button"
            className="btn join-item"
            disabled={maxTiny === 0n}
            onClick={() => setAmount(formatUnits(maxTiny, 8))}
          >
            Max
          </button>
          <span className="join-item grid place-items-center border border-base-300 px-3 text-sm">HBAR</span>
        </div>
      </label>

      {problem && amount && (
        <p className="m-0 mt-3 text-sm text-error" role="alert">
          {problem}
        </p>
      )}

      {sent && Object.keys(tx.runs).length > 0 && (
        <div className="mt-5">
          <TxSteps steps={[{ id: "revenue", label: sent, needed: true }]} runs={tx.runs} />
        </div>
      )}

      <div className="mt-5">
        <WalletGate ready={ready}>
          <button type="button" className="btn btn-primary w-full" disabled={!canSend} onClick={submit}>
            {tx.running ? "Working" : "Send revenue"}
          </button>
        </WalletGate>
      </div>
      {sources.length > 0 && (
        <div className="mt-6">
          <h3 className="m-0 text-sm font-medium">Revenue by source</h3>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {sources.map(row => (
                <tr key={row.source} className="border-t border-base-300">
                  <td className="py-1.5 pr-3">{row.source}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{fmtUnits(row.amount, 8, 4)} HBAR</td>
                  <td className="py-1.5 text-right text-xs text-base-content/60">
                    {total > 0n ? fmtShare(row.amount, total, 1) : ""} · {row.deposits}{" "}
                    {row.deposits === 1 ? "deposit" : "deposits"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 mt-2 text-xs text-base-content/60">
            Deposits made with <code>depositRevenue(source)</code> carry their label; plain transfers read as untagged.
          </p>
        </div>
      )}
      <p className="m-0 mt-3 text-xs text-base-content/60">
        Engine <ExternalLink href={hashscan.contract(ENGINE_ADDRESS)}>{shortAddress(ENGINE_ADDRESS)}</ExternalLink>
      </p>
    </Panel>
  );
}
