import { ExternalLink, Panel, Row } from "./ui";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useNow } from "~~/hooks/furnace/useNow";
import { ENGINE_ADDRESS, SKIP_TEXT, WEIBAR_PER_TINYBAR } from "~~/utils/furnace/constants";
import { fmtDuration, fmtUnits } from "~~/utils/furnace/format";
import { evmToEntityId, hashscan } from "~~/utils/furnace/hedera";

/** Runs the fuel reserve still pays for, or undefined while the gas price or fuel cannot be read. */
export function runsOfFuel(args: {
  balance: bigint;
  fuelReserve: bigint;
  scheduledGas: bigint;
  gasPriceWei: bigint | undefined;
  costPerRun: bigint | null | undefined;
}): { runs: bigint; reservation: bigint } | undefined {
  const { balance, fuelReserve, scheduledGas, gasPriceWei, costPerRun } = args;
  if (gasPriceWei === undefined) return undefined;
  // The payer must hold the whole gas reservation to start a run but is charged only the gas the run burns, so
  // runs = (fuel - reservation) / cost + 1, with the cost read from the last run the engine paid for.
  const reservation = scheduledGas * (gasPriceWei / WEIBAR_PER_TINYBAR);
  const fuel = balance < fuelReserve ? balance : fuelReserve;
  if (reservation === 0n) return undefined;
  if (fuel < reservation) return { runs: 0n, reservation };
  return { runs: costPerRun ? (fuel - reservation) / costPerRun + 1n : fuel / reservation, reservation };
}

export function EnginePanel({ snap }: { snap: Snapshot }) {
  const { engine, cfg, lv } = snap;
  const { s } = lv;
  const now = useNow(1000);
  const on = s.interval > 0n;
  const interval = Number(s.interval);
  const nextRunAt = Number(s.nextRunAt);
  const booked = s.pendingSchedule.toLowerCase() !== "0x0000000000000000000000000000000000000000";
  const costPerRun = engine.lastRunFee.data;
  const fuel = runsOfFuel({
    balance: s.balance,
    fuelReserve: cfg.fuelReserve,
    scheduledGas: cfg.scheduledGas,
    gasPriceWei: engine.gasPrice.data,
    costPerRun,
  });
  const revenue = s.balance > s.fuel ? s.balance - s.fuel : 0n;

  const countdown = (() => {
    if (!on) return { text: "Automation is off", note: "Buybacks run only when the owner triggers one." };
    if (!booked) {
      return { text: "No run booked", note: "Automation is on but Hedera holds no pending schedule.", bad: true };
    }
    if (now === null) return { text: "n/a" };
    const left = nextRunAt - now;
    return left > 0
      ? { text: `in ${fmtDuration(left)}`, note: new Date(nextRunAt * 1000).toLocaleString() }
      : { text: `${fmtDuration(-left)} past due`, note: "Waiting for the network to execute the schedule." };
  })();

  const preview = lv.preview
    ? lv.preview.skip === "None"
      ? `Would spend ${fmtUnits(lv.preview.spend, 8, 4)} HBAR`
      : `Would skip. ${SKIP_TEXT[lv.preview.skip]}`
    : "Unavailable while Chainlink is stale";

  return (
    <Panel
      id="engine-title"
      title="Engine"
      note={<ExternalLink href={hashscan.contract(ENGINE_ADDRESS)}>Contract on HashScan</ExternalLink>}
    >
      <div className="mt-5">
        <div className="text-xs font-medium text-steel">Next scheduled burn</div>
        <div className={`mt-2 font-mono text-2xl tabular-nums leading-none ${countdown.bad ? "text-error" : ""}`}>
          {countdown.text}
        </div>
        {countdown.note && <div className="mt-2 text-xs text-steel">{countdown.note}</div>}
      </div>

      <dl className="m-0 mt-4">
        <Row label="Revenue to spend" note="Balance above the fuel reserve. Buybacks draw only from this.">
          {fmtUnits(revenue, 8, 4)} HBAR
        </Row>
        <Row
          label="Fuel reserve"
          note={`The engine holds ${fmtUnits(s.balance, 8, 4)} HBAR in total. The reserve pays for scheduled runs and is never spent on buybacks.`}
        >
          {fmtUnits(s.fuel, 8, 4)} HBAR
        </Row>
        <Row label="If a buyback ran now">{preview}</Row>
        <Row label="Interval">{on ? `Every ${fmtDuration(interval)}` : "Off"}</Row>
        <Row label="Pending schedule">
          {booked ? (
            <ExternalLink href={hashscan.schedule(s.pendingSchedule)}>{evmToEntityId(s.pendingSchedule)}</ExternalLink>
          ) : (
            "None"
          )}
        </Row>
        <Row
          label="Runs of fuel left"
          note={
            fuel
              ? `Each run reserves ${fmtUnits(cfg.scheduledGas, 0, 0)} gas, ${fmtUnits(fuel.reservation, 8, 2)} HBAR at the current gas price${costPerRun ? `, and the last run cost ${fmtUnits(costPerRun, 8, 3)} HBAR` : ""}.${on && fuel.runs > 0n ? ` About ${fmtDuration(Number(fuel.runs) * interval)} at this interval.` : ""}`
              : undefined
          }
        >
          <span className={on && fuel?.runs === 0n ? "text-error" : ""}>{fuel ? fuel.runs.toString() : "n/a"}</span>
        </Row>
      </dl>

      {on && fuel?.runs === 0n && (
        <p className="m-0 mt-3 text-sm text-error" role="alert">
          The fuel reserve no longer covers one more scheduled run. Hedera checks the payer against the gas reserved, so
          the schedule fails until HBAR is sent to the engine.
        </p>
      )}
    </Panel>
  );
}
