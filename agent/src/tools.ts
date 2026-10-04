import {
  BaseQueryTool,
  BaseTransactionTool,
  type Context,
  type RawTransactionResponse,
  handleTransaction,
  isReturnBytesMode,
  transactionToolOutputParser,
  untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import type { Client, Transaction } from "@hiero-ledger/sdk";
import { type Address, encodeFunctionData, stringToHex } from "viem";
import type { z } from "zod";
import { engineAbi } from "./abi";
import { POLICY, type PolicySetting, policyArg, previewInfo, setterName, skipInfo } from "./analysis";
import { type ChainReader, type RawState, decodeRevert, engineEvents } from "./chain";
import { hasFunction } from "./config";
import { linkBuilder, mirrorTxId } from "./links";
import {
  buybackNowSchema,
  getFurnaceStateSchema,
  previewBuybackSchema,
  rearmAutomationSchema,
  sendRevenueSchema,
  setPolicySchema,
  startAutomationSchema,
  stopAutomationSchema,
} from "./schemas";
import { describeState, policyView, shapeState } from "./shape";
import { GAS, contractCall, requireOperator } from "./tx";
import { WEIBAR_PER_TINYBAR, fmt8, fmtUnits, parseAmount } from "./units";

export const TOOL_NAMES = {
  state: "get_furnace_state",
  preview: "preview_buyback",
  revenue: "send_revenue",
  buyback: "buyback_now",
  policy: "set_policy",
  start: "start_automation",
  stop: "stop_automation",
  rearm: "rearm_automation",
} as const;

/** The engine function each tool calls. A tool is offered only when the deployed ABI has it. */
export const TOOL_REQUIRES: Record<string, string[]> = {
  [TOOL_NAMES.state]: ["status"],
  [TOOL_NAMES.preview]: ["previewBuyback"],
  [TOOL_NAMES.revenue]: [],
  [TOOL_NAMES.buyback]: ["buyback"],
  [TOOL_NAMES.policy]: Object.keys(POLICY).map((s) => setterName(s as PolicySetting)),
  [TOOL_NAMES.start]: ["startAutomation"],
  [TOOL_NAMES.stop]: ["stopAutomation"],
  [TOOL_NAMES.rearm]: ["rearm"],
};

type Envelope = { raw: Record<string, unknown>; humanMessage: string };
/** A write tool's plan: the transaction to send and how to prove it worked once it has. */
type TxPlan = { tx: Transaction; summary: Record<string, unknown>; finish: (txId: string) => Promise<Envelope> };
const isPlan = (r: Envelope | TxPlan): r is TxPlan => "tx" in r;

const ok = (raw: Record<string, unknown>, humanMessage: string): Envelope => ({ raw: { status: "SUCCESS", ...raw }, humanMessage });
/** A refused write: nothing was sent. status is ERROR so callers classify it as a failure, `blocked` says why. */
const blocked = (reasons: string[], raw: Record<string, unknown> = {}): Envelope => ({
  raw: { status: "ERROR", blocked: true, reasons, ...raw },
  humanMessage: `Not sent: ${reasons.join(" ")}`,
});
const noop = (reason: string, raw: Record<string, unknown> = {}): Envelope => ({ raw: { status: "SUCCESS", noop: true, reason, ...raw }, humanMessage: reason });

abstract class EngineQueryTool extends BaseQueryTool {
  outputParser = untypedQueryOutputParser;
  constructor(protected readonly chain: ChainReader) {
    super();
  }
  async shouldSecondaryAction() {
    return false;
  }
}

abstract class EngineTxTool extends BaseTransactionTool {
  outputParser = transactionToolOutputParser;
  constructor(protected readonly chain: ChainReader) {
    super();
  }
  protected get links() {
    return linkBuilder(this.chain.cfg.hashscanUrl);
  }
  async shouldSecondaryAction(result: Envelope | TxPlan) {
    return isPlan(result);
  }

  async secondaryAction(plan: TxPlan, client: Client, context: Context) {
    const res = await handleTransaction(plan.tx, client, context);
    if (isReturnBytesMode(context.mode)) return { ...(res as object), plan: plan.summary };
    return plan.finish((res as { raw: RawTransactionResponse }).raw.transactionId);
  }

  /** The payer must hold the amount it sends plus the whole gas reservation (gas limit x gas price). */
  protected async fundsShort(s: RawState, account: Address, gas: number, tinybar = 0n): Promise<string | null> {
    const need = tinybar * WEIBAR_PER_TINYBAR + BigInt(gas) * s.gasPriceWeibar;
    const have = await this.chain.hbarBalance(account);
    return have < need ? `${account} holds ${fmt8(have / WEIBAR_PER_TINYBAR)} HBAR; this call needs ${fmt8(need / WEIBAR_PER_TINYBAR)} (amount plus the gas reservation).` : null;
  }

  /** Reasons an owner-only call cannot go ahead for this account, or [] when it is the owner. */
  protected notOwner(s: RawState, op: { accountId: string; evmAddress: Address }): string[] {
    return op.evmAddress.toLowerCase() === s.owner.toLowerCase() ? [] : [`Only the engine owner (${s.owner}) can do this; ${op.accountId} is ${op.evmAddress}.`];
  }

  protected async confirmed(txId: string) {
    const result = await this.chain.waitForResult(mirrorTxId(txId));
    if (result.result !== "SUCCESS") throw new Error(`Mirror node reports ${result.result} for ${txId}`);
    return result;
  }

  /** A failed receipt carries only a status code. Read the mirror node for the engine's own revert reason. */
  async handleError(error: unknown, context: Context) {
    const base = await super.handleError(error, context);
    const txId = base?.raw?.transactionId;
    if (!txId || base.raw.errorCode === undefined) return base;
    try {
      const result = await this.chain.waitForResult(mirrorTxId(txId));
      const revert = decodeRevert(result.error_message);
      const raw = { ...base.raw, links: { tx: this.links.tx(txId) }, ...(revert ? { revert } : {}), mirrorResult: result.result };
      return { raw, humanMessage: `${base.humanMessage}${revert ? ` Engine revert: ${revert.name}(${revert.args.join(", ")}).` : ""} ${this.links.tx(txId)}` };
    } catch (lookup) {
      return { ...base, raw: { ...base.raw, links: { tx: this.links.tx(txId) }, revertLookupError: String(lookup) } };
    }
  }
}

// ------------------------------------------------------------------ get_furnace_state

export class GetFurnaceState extends EngineQueryTool {
  method = TOOL_NAMES.state;
  name = "Get furnace state";
  description = `Read the Furnace buyback-and-burn engine from the chain: token supply, total burned and burn count split between the network's own scheduled runs and direct calls (counted from the mirror node and reconciled to the contract), the daily budget left in USD and HBAR, the buyback policy, the next scheduled burn, how many runs the engine's fuel covers, and whether a buyback would spend now or why it would be skipped. Read-only, no signature needed.`;
  parameters = getFurnaceStateSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return getFurnaceStateSchema.parse(params);
  }

  async coreAction(_p: unknown, _context: Context, _client: Client): Promise<Envelope> {
    const raw = await this.chain.readState();
    const ledger = await this.chain.burnLedger(raw.status.totalBurned);
    const state = shapeState(raw, ledger, this.chain.cfg);
    return ok({ ...state }, describeState(state));
  }
}

// ------------------------------------------------------------------ preview_buyback

export class PreviewBuyback extends EngineQueryTool {
  method = TOOL_NAMES.preview;
  name = "Preview buyback";
  description = `Say what a buyback would do right now, before sending anything: the HBAR it would spend (limited by the revenue above the fuel reserve, the daily USD budget, the price ceiling, the price impact cap, the lot cap), the tokens the router would return for that spend, or the exact reason it would be skipped (NoFunds, BudgetSpent, PriceCeiling, ImpactCap, TooSoon, LotCap, NoTwap, TwapWindow, TwapDeviation). Also says who may trigger it. Read-only.`;
  parameters = previewBuybackSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return previewBuybackSchema.parse(params);
  }

  async coreAction(_p: unknown, _context: Context, _client: Client): Promise<Envelope> {
    const s = await this.chain.readState();
    const info = previewInfo(s.preview);
    const available = s.status.balance > s.policy.fuelReserve ? s.status.balance - s.policy.fuelReserve : 0n;
    const quote = info.wouldSpend ? await this.chain.quoteBuy(s.status.token, info.spend) : null;
    const spendUsd = s.status.hbarUsd === 0n ? null : fmt8((info.spend * s.status.hbarUsd) / 10n ** 8n);
    const raw = {
      engine: s.engine,
      wouldSpend: info.wouldSpend,
      skip: info.skip,
      spendHbar: fmt8(info.spend),
      spendUsd,
      estimatedTokensBurned: quote === null ? null : fmtUnits(quote, s.tokenDecimals),
      tokenSymbol: s.tokenSymbol,
      availableAboveFuelHbar: fmt8(available),
      budgetLeftUsd: fmt8(s.status.budgetLeftUsd),
      whoMayTrigger: s.policy.minGapSeconds > 0n ? "the owner, or anyone while the buy would spend (minimum gap is set)" : "the owner only; the network's schedule also runs it",
      nextBuyAt: s.status.nextBuyAt === 0n ? null : Number(s.status.nextBuyAt),
      policy: policyView(s.policy),
      links: { engine: this.links.contract(s.engine) },
    };
    const msg = info.wouldSpend
      ? `A buyback now would spend ${raw.spendHbar} HBAR${spendUsd ? ` ($${spendUsd})` : ""}${raw.estimatedTokensBurned ? ` and burn about ${raw.estimatedTokensBurned} ${s.tokenSymbol}` : ""}.`
      : `A buyback now would be skipped: ${info.skip.name}. ${info.skip.meaning}`;
    return ok(raw, msg);
  }

  private get links() {
    return linkBuilder(this.chain.cfg.hashscanUrl);
  }
}

// ------------------------------------------------------------------ send_revenue

export class SendRevenue extends EngineTxTool {
  method = TOOL_NAMES.revenue;
  name = "Send revenue";
  description = `Send HBAR of protocol revenue to the Furnace engine from the agent's account. Everything above the engine's fuel reserve is spent on buybacks. With a source label (for example "swap-fees") the HBAR goes through depositRevenue(source) and is recorded on chain by origin; without one it arrives as a plain transfer. Checks the balance covers the amount plus the gas reservation, then proves the engine's RevenueTagged or RevenueReceived event carries the same amount from this account. Moves real funds.`;
  parameters = sendRevenueSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return sendRevenueSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof sendRevenueSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const tiny = parseAmount(p.hbar, "hbar");
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const short = await this.fundsShort(s, op.evmAddress, GAS.revenue, tiny);
    if (short) return blocked([short], { account: op.accountId });
    const tagged = p.source !== undefined && hasFunction(this.chain.cfg, "depositRevenue");
    const data = tagged ? encodeFunctionData({ abi: engineAbi, functionName: "depositRevenue", args: [stringToHex(p.source!, { size: 32 })] }) : null;
    const L = this.links;
    return {
      tx: contractCall(s.engine, data, GAS.revenue, tiny),
      summary: { account: op.accountId, hbar: p.hbar, path: tagged ? `depositRevenue("${p.source}")` : "plain transfer to receive()", sourceRecorded: tagged },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const ev = engineEvents(result, s.engine).find((e) => e.name === (tagged ? "RevenueTagged" : "RevenueReceived"));
        if (!ev) throw new Error(`Transaction ${txId} succeeded but the engine emitted no ${tagged ? "RevenueTagged" : "RevenueReceived"} event.`);
        if (ev.args.amount !== tiny) throw new Error(`The engine recorded ${ev.args.amount} tinybar of revenue, not the ${tiny} sent.`);
        if ((ev.args.from as string).toLowerCase() !== op.evmAddress.toLowerCase()) throw new Error(`The engine recorded revenue from ${ev.args.from}, not ${op.evmAddress}.`);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            account: op.accountId,
            hbarSent: fmt8(ev.args.amount as bigint),
            path: tagged ? "depositRevenue" : "receive",
            source: tagged ? p.source : null,
            sourceRecorded: tagged,
            event: ev.name,
            gasUsed: result.gas_used,
            links: { tx: L.tx(txId), engine: L.contract(s.engine) },
          },
          `Sent ${p.hbar} HBAR of revenue to the engine${tagged ? ` tagged "${p.source}"` : ""}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ buyback_now

export class BuybackNow extends EngineTxTool {
  method = TOOL_NAMES.buyback;
  name = "Buyback now";
  description = `Run a buyback and burn now instead of waiting for the scheduled run: the engine spends revenue within its budget, impact, ceiling and average-price limits, buys the token on SaucerSwap and burns it. Owner only, or anyone while the owner has set a minimum gap and the buy would spend. Checks the caller, and sends nothing when the engine would skip the run unless force is true. Proves the Burned event matches the contract's totalBurned afterwards.`;
  parameters = buybackNowSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return buybackNowSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof buybackNowSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const info = previewInfo(s.preview);
    const isOwner = op.evmAddress.toLowerCase() === s.owner.toLowerCase();
    if (!isOwner && s.policy.minGapSeconds === 0n)
      return blocked([`Only the engine owner (${s.owner}) can buy back on demand; ${op.accountId} is ${op.evmAddress}. The network's schedule runs it without the owner.`], { owner: s.owner });
    if (!isOwner && !info.wouldSpend) return blocked([`A non-owner call that would not spend reverts BuybackRefused (${info.skip.name}): ${info.skip.meaning}`], { skip: info.skip });
    if (!s.preview.ok) return blocked([info.skip.meaning], { skip: info.skip });
    if (!info.wouldSpend && !p.force)
      return noop(`A buyback now would be skipped (${info.skip.name}): ${info.skip.meaning} Pass force: true to send it anyway; it burns nothing, costs gas and moves the engine's price snapshot.`, { skip: info.skip });
    const short = await this.fundsShort(s, op.evmAddress, GAS.buyback);
    if (short) return blocked([short], { account: op.accountId });
    const L = this.links;
    const before = s.status.totalBurned;
    return {
      tx: contractCall(s.engine, encodeFunctionData({ abi: engineAbi, functionName: "buyback" }), GAS.buyback),
      summary: { account: op.accountId, expectedSpendHbar: fmt8(info.spend), skip: info.skip, forced: !info.wouldSpend },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const events = engineEvents(result, s.engine);
        const burned = events.find((e) => e.name === "Burned");
        const links = { tx: L.tx(txId), engine: L.contract(s.engine), token: L.token(s.status.token) };
        if (!burned) {
          const skipped = events.find((e) => e.name === "BuybackSkipped");
          if (!skipped) throw new Error(`Transaction ${txId} succeeded but the engine emitted neither Burned nor BuybackSkipped.`);
          const skip = skipInfo(Number(skipped.args.reason));
          return ok({ transactionId: txId, hash: result.hash, burned: false, skip, gasUsed: result.gas_used, links }, `The engine skipped the run: ${skip.name}. Nothing was spent or burned. ${L.tx(txId)}`);
        }
        const tokens = burned.args.tokensBurned as bigint;
        const after = await this.chain.readState();
        if (after.status.totalBurned < before + tokens) throw new Error(`Burned says ${tokens} tokens but totalBurned moved from ${before} to ${after.status.totalBurned}.`);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            burned: true,
            hbarSpent: fmt8(burned.args.hbarIn as bigint),
            tokensBurned: fmtUnits(tokens, s.tokenDecimals),
            priceHbar: fmt8(burned.args.priceHbar as bigint),
            priceUsd: fmt8(burned.args.priceUsd as bigint),
            supplyAfter: fmtUnits(burned.args.supplyAfter as bigint, s.tokenDecimals),
            totalBurnedAfter: fmtUnits(after.status.totalBurned, s.tokenDecimals),
            gasUsed: result.gas_used,
            links,
          },
          `Spent ${fmt8(burned.args.hbarIn as bigint)} HBAR, bought and burned ${fmtUnits(tokens, s.tokenDecimals)} ${s.tokenSymbol}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ set_policy

export class SetPolicy extends EngineTxTool {
  method = TOOL_NAMES.policy;
  name = "Set policy";
  description = `Owner only. Change one buyback policy parameter: ${Object.entries(POLICY)
    .map(([k, v]) => `${k} (${v.what})`)
    .join("; ")}. Validates the value against the contract's own bounds before sending, skips the call when the value is unchanged, and proves the new value reads back from the contract. Reports what a buyback would do under the new policy.`;
  parameters = setPolicySchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return setPolicySchema.parse(params);
  }

  async coreAction(p: z.infer<typeof setPolicySchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const setting = p.setting as PolicySetting;
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const denied = this.notOwner(s, op);
    if (denied.length) return blocked(denied, { owner: s.owner });
    const fn = setterName(setting);
    if (!hasFunction(this.chain.cfg, fn)) return blocked([`The deployed engine has no ${fn}.`]);
    let arg: bigint;
    try {
      arg = policyArg(setting, p.value);
    } catch (e) {
      return blocked([(e as Error).message]);
    }
    const current = s.policy[setting];
    const show = (v: bigint) => (POLICY[setting].kind === "usd" ? fmt8(v) : v.toString());
    if (current === arg) return noop(`${setting} is already ${show(arg)}.`, { setting, value: show(arg) });
    const short = await this.fundsShort(s, op.evmAddress, GAS.policy);
    if (short) return blocked([short], { account: op.accountId });
    const L = this.links;
    return {
      tx: contractCall(s.engine, encodeFunctionData({ abi: engineAbi, functionName: fn as "setDailyBudgetUsd", args: [arg] }), GAS.policy),
      summary: { setting, from: show(current), to: show(arg) },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const after = await this.chain.readState();
        if (after.policy[setting] !== arg) throw new Error(`${fn} returned but ${setting} reads ${after.policy[setting]}, not ${arg}.`);
        const effect = previewInfo(after.preview);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            setting,
            from: show(current),
            to: show(after.policy[setting]),
            policy: policyView(after.policy),
            buybackAfter: { wouldSpend: effect.wouldSpend, skip: effect.skip, spendHbar: fmt8(effect.spend) },
            gasUsed: result.gas_used,
            links: { tx: L.tx(txId), engine: L.contract(s.engine) },
          },
          `${setting} changed from ${show(current)} to ${show(after.policy[setting])}. A buyback now ${effect.wouldSpend ? `would spend ${fmt8(effect.spend)} HBAR` : `would be skipped (${effect.skip.name})`}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ start_automation

export class StartAutomation extends EngineTxTool {
  method = TOOL_NAMES.start;
  name = "Start automation";
  description = `Owner only. Turn on the engine's own schedule: the Hedera network then runs a buyback every intervalSeconds (60 to 5184000) from the engine's HBAR, with no keeper. Refuses when automation is already on or the engine's balance is below the gas reservation a booking needs. Proves the interval is set and a pending schedule with a future run time exists afterwards.`;
  parameters = startAutomationSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return startAutomationSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof startAutomationSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const denied = this.notOwner(s, op);
    if (denied.length) return blocked(denied, { owner: s.owner });
    if (s.status.interval !== 0n) return blocked([`Automation is already on, every ${s.status.interval}s. Stop it first to change the interval.`], { intervalSeconds: Number(s.status.interval) });
    const reservation = (s.policy.scheduledGas * s.gasPriceWeibar) / WEIBAR_PER_TINYBAR;
    if (s.status.balance < reservation)
      return blocked([`The engine holds ${fmt8(s.status.balance)} HBAR, below the ${fmt8(reservation)} HBAR gas reservation a booking needs. Send revenue first.`]);
    const short = await this.fundsShort(s, op.evmAddress, GAS.start);
    if (short) return blocked([short], { account: op.accountId });
    const L = this.links;
    const interval = BigInt(p.intervalSeconds);
    return {
      tx: contractCall(s.engine, encodeFunctionData({ abi: engineAbi, functionName: "startAutomation", args: [interval] }), GAS.start),
      summary: { intervalSeconds: p.intervalSeconds },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const after = await this.chain.readState();
        if (after.status.interval !== interval || /^0x0{40}$/i.test(after.status.pendingSchedule) || after.status.nextRunAt === 0n)
          throw new Error(`startAutomation returned but the engine shows interval ${after.status.interval}, schedule ${after.status.pendingSchedule}.`);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            intervalSeconds: p.intervalSeconds,
            pendingSchedule: after.status.pendingSchedule,
            nextRunAt: Number(after.status.nextRunAt),
            nextRunAtIso: new Date(Number(after.status.nextRunAt) * 1000).toISOString(),
            gasUsed: result.gas_used,
            links: { tx: L.tx(txId), schedule: L.schedule(after.status.pendingSchedule), engine: L.contract(s.engine) },
          },
          `Automation on: a buyback every ${p.intervalSeconds}s, next at ${new Date(Number(after.status.nextRunAt) * 1000).toISOString()}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ stop_automation

export class StopAutomation extends EngineTxTool {
  method = TOOL_NAMES.stop;
  name = "Stop automation";
  description = `Owner only. Turn off the engine's schedule and delete the pending scheduled run. Buybacks can still be run by hand. Does nothing when automation is already off. Proves the interval and the pending schedule read as cleared afterwards.`;
  parameters = stopAutomationSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return stopAutomationSchema.parse(params);
  }

  async coreAction(_p: unknown, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const denied = this.notOwner(s, op);
    if (denied.length) return blocked(denied, { owner: s.owner });
    if (s.status.interval === 0n) return noop("Automation is already off.");
    const short = await this.fundsShort(s, op.evmAddress, GAS.stop);
    if (short) return blocked([short], { account: op.accountId });
    const L = this.links;
    return {
      tx: contractCall(s.engine, encodeFunctionData({ abi: engineAbi, functionName: "stopAutomation" }), GAS.stop),
      summary: { deletesSchedule: s.status.pendingSchedule },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const after = await this.chain.readState();
        if (after.status.interval !== 0n || !/^0x0{40}$/i.test(after.status.pendingSchedule))
          throw new Error(`stopAutomation returned but the engine shows interval ${after.status.interval}, schedule ${after.status.pendingSchedule}.`);
        return ok(
          { transactionId: txId, hash: result.hash, deletedSchedule: s.status.pendingSchedule, gasUsed: result.gas_used, links: { tx: L.tx(txId), engine: L.contract(s.engine) } },
          `Automation off; the pending run was deleted. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ rearm_automation

export class RearmAutomation extends EngineTxTool {
  method = TOOL_NAMES.rearm;
  name = "Rearm automation";
  description = `Re-book the engine's scheduled buyback when the chain has died: automation is on but no run is pending, or the booked run is more than 10 minutes overdue. Anyone may call it; the engine's fuel pays for the new run. Does nothing when automation is off or a live run is booked. Proves a new pending schedule and run time exist afterwards.`;
  parameters = rearmAutomationSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return rearmAutomationSchema.parse(params);
  }

  async coreAction(_p: unknown, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const s = await this.chain.readState();
    const state = shapeState(s, null, this.chain.cfg);
    const a = state.nextBurn;
    if (a.status === "off") return noop("Automation is off, so there is nothing to rearm. The owner starts it with start_automation.", { automation: a });
    if (!a.rearmable)
      return noop(`A run is already booked for ${a.nextRunAtIso}${a.status === "past_due" ? `; it is overdue but inside the ${s.rearmGrace}s grace period` : ""}; rearm() would revert with ScheduleLive.`, { automation: a, links: state.links });
    const reservation = (s.policy.scheduledGas * s.gasPriceWeibar) / WEIBAR_PER_TINYBAR;
    if (s.status.balance < reservation)
      return blocked([`The engine holds ${fmt8(s.status.balance)} HBAR, below the ${fmt8(reservation)} HBAR gas reservation a booking needs. Send revenue to ${s.engine} first.`], { fuel: state.fuel });
    const short = await this.fundsShort(s, op.evmAddress, GAS.rearm);
    if (short) return blocked([short], { account: op.accountId });
    const L = this.links;
    const stale = s.status.pendingSchedule;
    return {
      tx: contractCall(s.engine, encodeFunctionData({ abi: engineAbi, functionName: "rearm" }), GAS.rearm),
      summary: { staleSchedule: a.pendingSchedule },
      finish: async (txId) => {
        const result = await this.confirmed(txId);
        const after = await this.chain.readState();
        if (/^0x0{40}$/i.test(after.status.pendingSchedule) || after.status.nextRunAt === 0n || after.status.pendingSchedule.toLowerCase() === stale.toLowerCase())
          throw new Error(`rearm() returned but the engine shows schedule ${after.status.pendingSchedule}.`);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            staleSchedule: /^0x0{40}$/i.test(stale) ? null : stale,
            pendingSchedule: after.status.pendingSchedule,
            nextRunAt: Number(after.status.nextRunAt),
            nextRunAtIso: new Date(Number(after.status.nextRunAt) * 1000).toISOString(),
            gasUsed: result.gas_used,
            links: { tx: L.tx(txId), schedule: L.schedule(after.status.pendingSchedule), engine: L.contract(s.engine) },
          },
          `Booked the next run for ${new Date(Number(after.status.nextRunAt) * 1000).toISOString()}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

