import { useState } from "react";
import { AssociationWarning } from "./AssociationWarning";
import { type PlannedStep, TxSteps } from "./TxSteps";
import { Panel } from "./ui";
import { type Hex, isAddress } from "viem";
import { useAssociations } from "~~/hooks/furnace/useAssociations";
import { isSet } from "~~/hooks/furnace/useEngine";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { type RunnableStep, useTx, useWalletReady } from "~~/hooks/furnace/useTx";
import { ENGINE_ABI, ENGINE_ADDRESS, GAS_FLOOR, SKIP_TEXT, WEIBAR_PER_TINYBAR } from "~~/utils/furnace/constants";
import { fmtBps, fmtDuration, fmtUnits, fmtUsd, fmtUsdPrice, parseAmount } from "~~/utils/furnace/format";

const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
const INT64_MAX = (1n << 63n) - 1n;

/** One transaction with its own status line, shared by every control below. */
function useAction() {
  const tx = useTx();
  const [last, setLast] = useState<{ id: string; label: string } | null>(null);
  const go = (id: string, label: string, send: () => Promise<Hex>) => {
    setLast({ id, label });
    return tx.run([{ id, send }]);
  };
  const status =
    last && Object.keys(tx.runs).length > 0 ? (
      <TxSteps steps={[{ id: last.id, label: last.label, needed: true }]} runs={tx.runs} />
    ) : null;
  return { tx, go, status };
}

const Section = ({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) => (
  <div className="flex flex-col gap-3 rounded-box border border-base-300 p-5">
    <div>
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      {hint && <p className="m-0 mt-1 text-xs text-steel">{hint}</p>}
    </div>
    {children}
  </div>
);

const Field = ({
  label,
  value,
  onChange,
  placeholder,
  mode = "decimal",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mode?: "decimal" | "numeric" | "text";
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs text-slate">{label}</span>
    <input
      inputMode={mode}
      className="input w-full min-w-0 font-mono tabular-nums"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  </label>
);

function BuybackNow({ snap }: { snap: Snapshot }) {
  const { lv } = snap;
  const { tx, go, status } = useAction();
  const p = lv.preview;
  const ok = p?.skip === "None";
  return (
    <Section
      title="Buy back and burn now"
      hint="Runs the same sizing as a scheduled run. Only the owner can trigger one by hand."
    >
      <p className="m-0 text-sm">
        {p
          ? ok
            ? `It would spend ${fmtUnits(p.spend, 8, 4)} HBAR.`
            : `It would skip. ${SKIP_TEXT[p.skip]}`
          : "The dry run reverts while Chainlink is stale."}
      </p>
      {status}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ok || tx.running}
        onClick={() =>
          go("buyback", "Buy back and burn", () =>
            tx.call({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "buyback" }, GAS_FLOOR.buyback),
          )
        }
      >
        {tx.running ? "Working" : "Buy back now"}
      </button>
    </Section>
  );
}

function PolicyRow({
  label,
  current,
  hint,
  unit,
  parse,
  send,
}: {
  label: string;
  current: string;
  hint: string;
  unit: string;
  parse: (text: string) => bigint | null;
  send: (value: bigint, tx: ReturnType<typeof useTx>) => Promise<Hex>;
}) {
  const { tx, go, status } = useAction();
  const [text, setText] = useState("");
  const value = parse(text);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-xs tabular-nums text-steel">now {current}</span>
      </div>
      <div className="join w-full">
        <input
          inputMode="decimal"
          className="input join-item w-full min-w-0 font-mono tabular-nums"
          placeholder={unit}
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label={`${label} in ${unit}`}
        />
        <button
          type="button"
          className="btn join-item"
          disabled={value === null || tx.running}
          onClick={async () => {
            if (await go(label, `Set ${label.toLowerCase()} to ${text} ${unit}`, () => send(value!, tx))) setText("");
          }}
        >
          Set
        </button>
      </div>
      <p className="m-0 text-xs text-steel">{hint}</p>
      {status}
    </div>
  );
}

function PolicyControls({ snap }: { snap: Snapshot }) {
  const { cfg, lv } = snap;
  const call = <const fn extends "setDailyBudgetUsd" | "setMaxImpactBps" | "setPriceCeilingUsd" | "setSlippageBps">(
    tx: ReturnType<typeof useTx>,
    functionName: fn,
    value: bigint,
  ) => tx.call({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName, args: [value] } as never, GAS_FLOOR.setPolicy);
  const bps = (max: number, min: number) => (text: string) => {
    const v = parseAmount(text, 2);
    return v !== null && v >= BigInt(min) && v <= BigInt(max) ? v : null;
  };
  return (
    <Section
      title="Policy"
      hint="Each change is one transaction, bounded by the contract, and lands in the activity feed."
    >
      <PolicyRow
        label="Daily budget"
        unit="USD"
        current={fmtUsd(lv.dailyBudgetUsd)}
        hint="USD the engine may spend per 24 hours, priced by Chainlink."
        parse={t => parseAmount(t, 8)}
        send={(v, tx) => call(tx, "setDailyBudgetUsd", v)}
      />
      <PolicyRow
        label="Max price impact"
        unit="%"
        current={fmtBps(lv.maxImpactBps)}
        hint={`Between 0.01% and ${fmtBps(cfg.maxImpactBps)}.`}
        parse={bps(cfg.maxImpactBps, 1)}
        send={(v, tx) => call(tx, "setMaxImpactBps", v)}
      />
      <PolicyRow
        label="Price ceiling"
        unit="USD per token"
        current={lv.priceCeilingUsd === 0n ? "none" : fmtUsdPrice(lv.priceCeilingUsd)}
        hint="The engine never buys above it. Enter 0 to remove it."
        parse={t => parseAmount(t, 8)}
        send={(v, tx) => call(tx, "setPriceCeilingUsd", v)}
      />
      <PolicyRow
        label="Slippage"
        unit="%"
        current={fmtBps(lv.slippageBps)}
        hint={`Between 0% and ${fmtBps(cfg.maxSlippageBps)}.`}
        parse={bps(cfg.maxSlippageBps, 0)}
        send={(v, tx) => call(tx, "setSlippageBps", v)}
      />
    </Section>
  );
}

function AutomationControls({ snap, runs }: { snap: Snapshot; runs: bigint | undefined }) {
  const { cfg, lv } = snap;
  const { tx, go, status } = useAction();
  const [interval, setIntervalValue] = useState("6");
  const [unit, setUnit] = useState<keyof typeof UNITS>("hours");
  const on = lv.s.interval > 0n;
  const seconds = (() => {
    const n = parseAmount(interval, 0);
    return n === null ? null : Number(n) * UNITS[unit];
  })();
  const ok = seconds !== null && seconds >= cfg.minInterval && seconds <= cfg.maxInterval;

  return (
    <Section
      title={on ? "Stop automation" : "Start automation"}
      hint="The engine books its own buyback with the Hedera Schedule Service."
    >
      {on ? (
        <button
          type="button"
          className="btn btn-outline"
          disabled={tx.running}
          onClick={() =>
            go("stop", "Stop automation", () =>
              tx.call(
                { address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "stopAutomation" },
                GAS_FLOOR.stopAutomation,
              ),
            )
          }
        >
          Stop and delete the pending schedule
        </button>
      ) : (
        <>
          <div className="join w-full">
            <input
              inputMode="numeric"
              className="input join-item w-full min-w-0 font-mono tabular-nums"
              value={interval}
              onChange={e => setIntervalValue(e.target.value)}
              aria-label="Interval"
            />
            <select
              className="select join-item w-auto"
              value={unit}
              onChange={e => setUnit(e.target.value as keyof typeof UNITS)}
              aria-label="Interval unit"
            >
              {Object.keys(UNITS).map(u => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
          <p className="m-0 text-xs text-steel">
            Between {fmtDuration(cfg.minInterval)} and {fmtDuration(cfg.maxInterval)}.
            {runs === 0n && " The fuel reserve does not cover a run yet, so send HBAR to the engine first."}
          </p>
          <button
            type="button"
            className="btn btn-outline"
            disabled={!ok || tx.running || runs === 0n}
            onClick={() =>
              go("start", `Start automation every ${fmtDuration(seconds!)}`, () =>
                tx.call(
                  {
                    address: ENGINE_ADDRESS,
                    abi: ENGINE_ABI,
                    functionName: "startAutomation",
                    args: [BigInt(seconds!)],
                  },
                  GAS_FLOOR.startAutomation,
                ),
              )
            }
          >
            Start automation
          </button>
        </>
      )}
      {status}
    </Section>
  );
}

function ClaimControls({ snap }: { snap: Snapshot }) {
  const { engine, lv } = snap;
  const ready = useWalletReady();
  const tx = useTx();
  const [to, setTo] = useState("");
  const recipient = to || ready.address || "";
  const valid = isAddress(recipient);
  const token = lv.s.token;
  const [assoc] = useAssociations(valid ? (recipient as `0x${string}`) : undefined, isSet(token) ? [token] : []);
  const mine = !!ready.address && recipient.toLowerCase() === ready.address.toLowerCase();
  const needs = assoc?.state.kind === "needs";
  const known = assoc?.state.kind === "associated" || assoc?.state.kind === "auto" || needs;
  const left = lv.s.teamUnclaimed;
  const symbol = engine.tokenInfo.data?.symbol ?? "tokens";
  const canSend = valid && left > 0n && known && !tx.running && (!needs || mine);

  const steps: PlannedStep[] = [
    {
      id: "assoc",
      label: `Associate ${symbol} with your account`,
      hint: "A Hedera account receives a token only after associating with it.",
      needed: needs && mine,
    },
    { id: "claim", label: `Claim ${fmtUnits(left, lv.tokenDecimals, 2)} ${symbol}`, needed: true },
  ];

  const submit = async () => {
    const queue: RunnableStep[] = [];
    if (needs && mine) queue.push(tx.associateStep(token, "assoc"));
    queue.push({
      id: "claim",
      send: () =>
        tx.call(
          {
            address: ENGINE_ADDRESS,
            abi: ENGINE_ABI,
            functionName: "claimTeamAllocation",
            args: [recipient as `0x${string}`],
          },
          GAS_FLOOR.claimTeamAllocation,
        ),
    });
    await tx.run(queue);
  };

  return (
    <Section
      title="Claim team allocation"
      hint={`${fmtUnits(left, lv.tokenDecimals, 2)} ${symbol} remain. The team allocation is never burned.`}
    >
      {left === 0n ? (
        <p className="m-0 text-sm text-slate">The whole team allocation has been claimed.</p>
      ) : (
        <>
          <Field label="Recipient" mode="text" value={to} onChange={setTo} placeholder={ready.address ?? "0x…"} />
          <AssociationWarning state={assoc?.state} />
          {needs && !mine && (
            <p className="m-0 text-sm text-warning" role="alert">
              That account has not associated {symbol}. It must do so from its own wallet before it can receive.
            </p>
          )}
          {Object.keys(tx.runs).length > 0 && <TxSteps steps={steps} runs={tx.runs} />}
          <button type="button" className="btn btn-outline" disabled={!canSend} onClick={submit}>
            {tx.running ? "Working" : needs && mine ? "Associate and claim" : "Claim"}
          </button>
        </>
      )}
    </Section>
  );
}

function SetupControls({ snap }: { snap: Snapshot }) {
  const { lv } = snap;
  const { tx, go, status } = useAction();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [liquidity, setLiquidity] = useState("");
  const [decimals, setDecimals] = useState("8");
  const [fee, setFee] = useState("20");
  const [seedHbar, setSeedHbar] = useState("");

  if (!isSet(lv.s.token)) {
    const d = Number(decimals);
    const total = Number.isInteger(d) && d >= 0 && d <= 18 ? parseAmount(supply, d) : null;
    const liq = Number.isInteger(d) && d >= 0 && d <= 18 ? parseAmount(liquidity, d) : null;
    const feeTiny = parseAmount(fee, 8);
    const ok =
      !!name &&
      !!symbol &&
      total !== null &&
      liq !== null &&
      feeTiny !== null &&
      feeTiny > 0n &&
      total > 0n &&
      total <= INT64_MAX &&
      liq > 0n &&
      liq <= total;
    return (
      <Section
        title="Step 1: create the token"
        hint="Finite supply, the engine as treasury and sole supply-key holder, no admin, wipe, freeze, pause or KYC key. HTS keeps its creation fee from the HBAR sent and the rest stays in the engine."
      >
        <Field label="Name" mode="text" value={name} onChange={setName} />
        <Field label="Symbol" mode="text" value={symbol} onChange={setSymbol} />
        <Field label="Total supply (whole tokens)" value={supply} onChange={setSupply} />
        <Field
          label="Liquidity allocation (whole tokens, the rest is the team allocation)"
          value={liquidity}
          onChange={setLiquidity}
        />
        <Field label="Decimals" mode="numeric" value={decimals} onChange={setDecimals} />
        <Field label="HBAR to send for the creation fee" value={fee} onChange={setFee} />
        {status}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ok || tx.running}
          onClick={() =>
            go("initialize", `Create ${symbol}`, () =>
              tx.call(
                {
                  address: ENGINE_ADDRESS,
                  abi: ENGINE_ABI,
                  functionName: "initialize",
                  args: [name, symbol, total!, d, liq!],
                  value: feeTiny! * WEIBAR_PER_TINYBAR,
                },
                GAS_FLOOR.initialize,
              ),
            )
          }
        >
          {tx.running ? "Working" : "Create token"}
        </button>
      </Section>
    );
  }

  if (!isSet(lv.s.pair)) {
    const required = lv.poolFee;
    const sendTiny = required !== undefined ? (required * 105n) / 100n : undefined;
    return (
      <Section
        title="Step 2: create the SaucerSwap pool"
        hint="Pays SaucerSwap's pair fee, priced in USD and converted to HBAR at the current rate. Five percent extra covers a rate move and stays in the engine as fuel."
      >
        <p className="m-0 text-sm">
          Pair fee {required !== undefined ? `${fmtUnits(required, 8, 4)} HBAR` : "unavailable"}
          {sendTiny !== undefined ? `, sending ${fmtUnits(sendTiny, 8, 4)} HBAR` : ""}.
        </p>
        {status}
        <button
          type="button"
          className="btn btn-primary"
          disabled={sendTiny === undefined || tx.running}
          onClick={() =>
            go("createPool", "Create the pool", () =>
              tx.call(
                {
                  address: ENGINE_ADDRESS,
                  abi: ENGINE_ABI,
                  functionName: "createPool",
                  value: sendTiny! * WEIBAR_PER_TINYBAR,
                },
                GAS_FLOOR.createPool,
              ),
            )
          }
        >
          {tx.running ? "Working" : "Create pool"}
        </button>
      </Section>
    );
  }

  const want = lv.s.liquidityUnseeded;
  if (want > 0n) {
    const hbar = parseAmount(seedHbar, 8);
    return (
      <Section
        title="Step 3: seed the liquidity"
        hint="Pairs the liquidity allocation with the HBAR you enter. The LP tokens stay in the engine for good. It reverts if the pool already holds liquidity at another ratio."
      >
        <p className="m-0 text-sm">{fmtUnits(want, lv.tokenDecimals, 2)} tokens go in.</p>
        <Field label="HBAR to pair with them" value={seedHbar} onChange={setSeedHbar} />
        {status}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!hbar || tx.running}
          onClick={() =>
            go("seed", "Seed the pool", () =>
              tx.call(
                {
                  address: ENGINE_ADDRESS,
                  abi: ENGINE_ABI,
                  functionName: "seedLiquidity",
                  args: [want, hbar!],
                  value: hbar! * WEIBAR_PER_TINYBAR,
                },
                GAS_FLOOR.seedLiquidity,
              ),
            )
          }
        >
          {tx.running ? "Working" : "Seed liquidity"}
        </button>
      </Section>
    );
  }
  return null;
}

/** Owner-only: rendered when the connected account is the engine's owner(). */
export function OwnerControls({ snap, runs }: { snap: Snapshot; runs: bigint | undefined }) {
  const { lv } = snap;
  const initialised = isSet(lv.s.token) && isSet(lv.s.pair) && lv.s.liquidityUnseeded === 0n;
  return (
    <Panel id="owner-title" title="Owner controls" note="Visible because your wallet is the engine owner">
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SetupControls snap={snap} />
        {initialised && <BuybackNow snap={snap} />}
        {initialised && <PolicyControls snap={snap} />}
        {initialised && <AutomationControls snap={snap} runs={runs} />}
        {isSet(lv.s.token) && <ClaimControls snap={snap} />}
      </div>
      <p className="m-0 mt-5 text-xs text-steel">
        None of these can move HBAR, LP tokens or bought tokens out of the engine. Ownership transfer is on the Debug
        Contracts page.
      </p>
    </Panel>
  );
}
