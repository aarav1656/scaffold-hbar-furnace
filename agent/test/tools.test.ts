import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { HederaAIToolkit } from "@hashgraph/hedera-agent-kit-ai-sdk";
import { Client, ContractExecuteTransaction, Transaction } from "@hiero-ledger/sdk";
import { encodeFunctionData, stringToHex } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { engineAbi } from "../src/abi";
import type { ChainReader } from "../src/chain";
import { type EngineConfig, configFromEnv } from "../src/config";
import { createFurnacePlugin, furnaceToolNames as T } from "../src/plugin";
import { ENGINE, OWNER, SCHEDULE, STRANGER, ZERO, cfg, ledger, log, result, state, stubChain } from "./fixture";

const ctx: Context = { mode: AgentMode.RETURN_BYTES, accountId: "0.0.10855086" };
let client: Client;
beforeAll(() => {
  client = Client.forTestnet();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const tool = (chain: ChainReader, method: string, config: EngineConfig = cfg()) => {
  const t = createFurnacePlugin(config, chain).tools(ctx).find((x) => x.method === method);
  if (!t) throw new Error(`no tool ${method}`);
  return t as any;
};
/** Runs the tool through the Agent Kit (validation, RETURN_BYTES). */
const run = (chain: ChainReader, method: string, params: unknown) => tool(chain, method).execute(client, ctx, params);
/** The tool's own decision before anything is sent: a refusal envelope, or a plan whose `finish` proves the result. */
const plan = (chain: ChainReader, method: string, params: unknown) => tool(chain, method).coreAction(params, ctx, client);
const decode = (out: { bytes: Uint8Array }) => {
  const tx = Transaction.fromBytes(out.bytes) as ContractExecuteTransaction;
  return { tx, data: tx.functionParameters && tx.functionParameters.length ? `0x${Buffer.from(tx.functionParameters).toString("hex")}` : "0x" };
};
const TX = "0.0.10855086@1791141030.708087468";

describe("plugin", () => {
  it("exposes the eight tools, queries and transactions typed, each with a description", () => {
    const tools = createFurnacePlugin(cfg(), stubChain()).tools(ctx);
    expect(tools.map((t) => t.method)).toEqual(["get_furnace_state", "preview_buyback", "send_revenue", "buyback_now", "set_policy", "start_automation", "stop_automation", "rearm_automation"]);
    expect(tools.map((t) => t.toolType)).toEqual(["query", "query", "transaction", "transaction", "transaction", "transaction", "transaction", "transaction"]);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(80);
  });

  it("offers only the tools the deployed ABI supports", () => {
    const old = { ...cfg(), abiFunctions: new Set(["status", "previewBuyback", "buyback", "startAutomation", "stopAutomation"]) };
    const methods = createFurnacePlugin(old, stubChain()).tools(ctx).map((t) => t.method);
    expect(methods).not.toContain("rearm_automation");
    expect(methods).not.toContain("set_policy");
    expect(methods).toContain("send_revenue");
    expect(methods).toContain("get_furnace_state");
  });

  it("loads into the Agent Kit AI SDK toolkit and runs a tool through the adapter", async () => {
    const toolkit = new HederaAIToolkit({ client, configuration: { plugins: [createFurnacePlugin(cfg(), stubChain())], context: ctx } });
    expect(Object.keys(toolkit.getTools())).toEqual(expect.arrayContaining(["get_furnace_state", "send_revenue", "buyback_now", "set_policy"]));
    const out = (await toolkit.getTools().get_furnace_state!.execute!({}, { toolCallId: "1", messages: [] } as never)) as { raw: { burned: { totalBurned: string } }; humanMessage: string };
    expect(out.raw.burned.totalBurned).toBe("11338.43256835");
    expect(out.humanMessage).toContain("11338.43256835 FURN burned");
  });
});

describe("get_furnace_state", () => {
  it("returns supply, burn split, budget, next burn and fuel", async () => {
    const out = await run(stubChain(), T.state, {});
    expect(out.raw).toMatchObject({
      status: "SUCCESS",
      token: { symbol: "FURN" },
      burned: { burns: { network: 3, manual: 1 }, mirrorReconciled: true },
      budget: { leftUsd: "4.7", leftHbar: "45.55452309" },
      nextBurn: { status: "scheduled" },
      fuel: { runsCovered: 16, basis: "last-run-cost" },
    });
    expect(out.humanMessage).toContain("4 burns: 3 by the network's schedule, 1 by direct calls.");
  });
  it("says so when the mirror node total does not match the contract", async () => {
    const out = await run(stubChain({ ledger: ledger({ reconciled: false }) }), T.state, {});
    expect(out.raw.burned.mirrorReconciled).toBe(false);
  });
});

describe("preview_buyback", () => {
  it("states the spend and the tokens it would burn", async () => {
    const out = await run(stubChain(), T.preview, {});
    expect(out.raw).toMatchObject({ wouldSpend: true, spendHbar: "2.90773551", spendUsd: "0.29999999", estimatedTokensBurned: "10647.14082776", whoMayTrigger: expect.stringContaining("anyone") });
  });
  it.each([
    [2, "NoFunds"],
    [3, "BudgetSpent"],
    [10, "TwapDeviation"],
  ])("explains skip %i as %s and quotes nothing", async (skip, name) => {
    const out = await run(stubChain({ state: state({ preview: { ok: true, skip, spend: 0n } }) }), T.preview, {});
    expect(out.raw).toMatchObject({ wouldSpend: false, skip: { name }, estimatedTokensBurned: null });
    expect(out.humanMessage).toContain(name);
  });
  it("explains a stale oracle instead of failing", async () => {
    const out = await run(stubChain({ state: state({ status: { hbarUsd: 0n }, preview: { ok: false, reason: "StaleOracle" } }) }), T.preview, {});
    expect(out.raw).toMatchObject({ wouldSpend: false, spendUsd: null, skip: { name: "StaleOracle" } });
  });
});

describe("send_revenue", () => {
  it("builds a plain payable call that triggers receive() when there is no source", async () => {
    const out = await run(stubChain(), T.revenue, { hbar: "1" });
    const { tx, data } = decode(out);
    expect(data).toBe("0x");
    expect(tx.payableAmount!.toTinybars().toString()).toBe("100000000");
    expect(Buffer.from(out.bytes).toString("hex")).toContain(ENGINE.slice(2));
    expect(out.plan).toMatchObject({ hbar: "1", sourceRecorded: false });
  });

  it("calls depositRevenue(source) with the label as bytes32", async () => {
    const out = await run(stubChain(), T.revenue, { hbar: "2.5", source: "swap-fees" });
    const { tx, data } = decode(out);
    expect(data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "depositRevenue", args: [stringToHex("swap-fees", { size: 32 })] }));
    expect(tx.payableAmount!.toTinybars().toString()).toBe("250000000");
    expect(out.plan.sourceRecorded).toBe(true);
  });

  it("falls back to a plain transfer when the deployed ABI has no depositRevenue", async () => {
    const old = { ...cfg(), abiFunctions: new Set(["status"]) };
    const out = await tool(stubChain({ cfg: old }), T.revenue, old).execute(client, ctx, { hbar: "1", source: "swap-fees" });
    expect(decode(out).data).toBe("0x");
    expect(out.plan.sourceRecorded).toBe(false);
  });

  it("blocks when the balance cannot cover the amount plus the gas reservation, and sends nothing", async () => {
    const out = await run(stubChain({ hbarBalance: 1n * 10n ** 18n }), T.revenue, { hbar: "1" });
    expect(out.bytes).toBeUndefined();
    expect(out.raw).toMatchObject({ status: "ERROR", blocked: true });
    expect(out.raw.reasons[0]).toContain("gas reservation");
  });

  it.each(["0", "-2", "1.123456789", "lots"])("rejects hbar %j before touching the chain", async (hbar) => {
    expect((await run(stubChain(), T.revenue, { hbar })).raw.status).toBe("ERROR");
  });

  it("proves a tagged deposit from the RevenueTagged event: amount and sender", async () => {
    const p = await plan(stubChain({ result: result([log("RevenueTagged", { source: stringToHex("swap-fees", { size: 32 }), from: OWNER, amount: 100_000_000n })]) }), T.revenue, { hbar: "1", source: "swap-fees" });
    const done = await p.finish(TX);
    expect(done.raw).toMatchObject({ status: "SUCCESS", hbarSent: "1", event: "RevenueTagged", source: "swap-fees", sourceRecorded: true });
    expect(done.raw.links.tx).toBe("https://hashscan.io/testnet/transaction/0.0.10855086-1791141030-708087468");
  });

  it("fails when the event amount differs from what was sent", async () => {
    const p = await plan(stubChain({ result: result([log("RevenueReceived", { from: OWNER, amount: 99_999_999n })]) }), T.revenue, { hbar: "1" });
    await expect(p.finish(TX)).rejects.toThrow(/not the 100000000 sent/);
  });
  it("fails when the event names another sender", async () => {
    const p = await plan(stubChain({ result: result([log("RevenueReceived", { from: STRANGER, amount: 100_000_000n })]) }), T.revenue, { hbar: "1" });
    await expect(p.finish(TX)).rejects.toThrow(/not 0x/);
  });
  it("fails when the transaction succeeded but the engine emitted nothing, or another contract did", async () => {
    await expect((await plan(stubChain({ result: result([]) }), T.revenue, { hbar: "1" })).finish(TX)).rejects.toThrow(/no RevenueReceived event/);
    const other = await plan(stubChain({ result: result([log("RevenueReceived", { from: OWNER, amount: 100_000_000n }, STRANGER)]) }), T.revenue, { hbar: "1" });
    await expect(other.finish(TX)).rejects.toThrow(/no RevenueReceived event/);
  });
  it("fails when the mirror node reports a reverted transaction", async () => {
    const p = await plan(stubChain({ result: result([], { result: "CONTRACT_REVERT_EXECUTED" }) }), T.revenue, { hbar: "1" });
    await expect(p.finish(TX)).rejects.toThrow(/CONTRACT_REVERT_EXECUTED/);
  });
});

describe("buyback_now", () => {
  const burnedLog = (tokens = 1_064_714_082_776n) => log("Burned", { hbarIn: 290_773_551n, tokensBurned: tokens, priceHbar: 27_311n, priceUsd: 2_817n, supplyAfter: 98_866_156_743_165n - tokens });
  const owner = (over: Parameters<typeof state>[0] = {}) => ({ state: state(over), evm: OWNER });

  it("builds the engine's buyback() for the owner when it would spend", async () => {
    const out = await run(stubChain(owner()), T.buyback, {});
    expect(decode(out).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "buyback" }));
    expect(out.plan).toMatchObject({ expectedSpendHbar: "2.90773551", forced: false });
  });

  it("sends nothing when the engine would skip, and says why", async () => {
    const out = await run(stubChain(owner({ preview: { ok: true, skip: 3, spend: 0n } })), T.buyback, {});
    expect(out.bytes).toBeUndefined();
    expect(out.raw).toMatchObject({ status: "SUCCESS", noop: true, skip: { name: "BudgetSpent" } });
  });

  it("sends a skipped run only with force", async () => {
    const out = await run(stubChain(owner({ preview: { ok: true, skip: 3, spend: 0n } })), T.buyback, { force: true });
    expect(out.plan).toMatchObject({ forced: true });
    expect(decode(out).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "buyback" }));
  });

  it("refuses to build a call that would revert on a stale oracle, even with force", async () => {
    const out = await run(stubChain(owner({ preview: { ok: false, reason: "StaleOracle" } })), T.buyback, { force: true });
    expect(out.raw).toMatchObject({ status: "ERROR", blocked: true, skip: { name: "StaleOracle" } });
  });

  it("blocks a non-owner while no minimum gap is set", async () => {
    const out = await run(stubChain({ evm: STRANGER, state: state({ policy: { minGapSeconds: 0n } }) }), T.buyback, {});
    expect(out.bytes).toBeUndefined();
    expect(out.raw).toMatchObject({ status: "ERROR", blocked: true, owner: OWNER });
  });

  it("lets a non-owner trigger a buy that would spend once a gap is set, and blocks one that would not", async () => {
    const ok = await run(stubChain({ evm: STRANGER }), T.buyback, {});
    expect(decode(ok).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "buyback" }));
    const no = await run(stubChain({ evm: STRANGER, state: state({ preview: { ok: true, skip: 6, spend: 0n } }) }), T.buyback, { force: true });
    expect(no.raw).toMatchObject({ status: "ERROR", blocked: true });
    expect(no.raw.reasons[0]).toContain("BuybackRefused (TooSoon)");
  });

  it("proves the burn: Burned event and the totalBurned it moved", async () => {
    const tokens = 1_064_714_082_776n;
    const after = state({ status: { totalBurned: 1_133_843_256_835n + tokens } });
    const p = await plan(stubChain({ ...owner(), stateAfter: after, result: result([burnedLog(tokens)]) }), T.buyback, {});
    const done = await p.finish(TX);
    expect(done.raw).toMatchObject({ status: "SUCCESS", burned: true, hbarSpent: "2.90773551", tokensBurned: "10647.14082776", });
    expect(done.raw.totalBurnedAfter).toBe("21985.57339611");
  });

  it("fails when Burned says tokens were burned but totalBurned did not move", async () => {
    const p = await plan(stubChain({ ...owner(), stateAfter: state(), result: result([burnedLog()]) }), T.buyback, {});
    await expect(p.finish(TX)).rejects.toThrow(/totalBurned moved/);
  });

  it("reports a skipped run from BuybackSkipped as success with nothing burned", async () => {
    const p = await plan(stubChain({ ...owner({ preview: { ok: true, skip: 3, spend: 0n } }), result: result([log("BuybackSkipped", { reason: 3 })]) }), T.buyback, { force: true });
    const done = await p.finish(TX);
    expect(done.raw).toMatchObject({ burned: false, skip: { name: "BudgetSpent" } });
  });

  it("fails when neither Burned nor BuybackSkipped appears", async () => {
    const p = await plan(stubChain({ ...owner(), result: result([]) }), T.buyback, {});
    await expect(p.finish(TX)).rejects.toThrow(/neither Burned nor BuybackSkipped/);
  });
});

describe("set_policy", () => {
  it("builds the matching setter with the value in the contract's units", async () => {
    const out = await run(stubChain(), T.policy, { setting: "dailyBudgetUsd", value: "7.5" });
    expect(decode(out).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "setDailyBudgetUsd", args: [750_000_000n] }));
    expect(out.plan).toMatchObject({ setting: "dailyBudgetUsd", from: "5", to: "7.5" });
    const bps = await run(stubChain(), T.policy, { setting: "slippageBps", value: 100 });
    expect(decode(bps).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "setSlippageBps", args: [100n] }));
  });
  it("blocks values the contract would revert on, without sending", async () => {
    for (const [setting, value] of [["maxImpactBps", "1001"], ["maxTwapDeviationBps", "10"], ["maxLotUsd", "0.05"]]) {
      const out = await run(stubChain(), T.policy, { setting, value });
      expect(out.bytes).toBeUndefined();
      expect(out.raw).toMatchObject({ status: "ERROR", blocked: true });
    }
  });
  it("blocks a caller who is not the owner", async () => {
    const out = await run(stubChain({ evm: STRANGER }), T.policy, { setting: "slippageBps", value: "100" });
    expect(out.raw).toMatchObject({ status: "ERROR", blocked: true, owner: OWNER });
    expect(out.bytes).toBeUndefined();
  });
  it("skips an unchanged value", async () => {
    const out = await run(stubChain(), T.policy, { setting: "slippageBps", value: "300" });
    expect(out.raw).toMatchObject({ noop: true });
    expect(out.bytes).toBeUndefined();
  });
  it("refuses a setting the schema does not know", async () => {
    expect((await run(stubChain(), T.policy, { setting: "owner", value: "1" })).raw.status).toBe("ERROR");
  });
  it("proves the new value by reading it back, and reports its effect on the next buyback", async () => {
    const after = state({ policy: { dailyBudgetUsd: 0n }, preview: { ok: true, skip: 3, spend: 0n } });
    const p = await plan(stubChain({ stateAfter: after }), T.policy, { setting: "dailyBudgetUsd", value: "0" });
    const done = await p.finish(TX);
    expect(done.raw).toMatchObject({ setting: "dailyBudgetUsd", from: "5", to: "0", buybackAfter: { wouldSpend: false, skip: { name: "BudgetSpent" } } });
  });
  it("fails when the setter returned but the value did not change", async () => {
    const p = await plan(stubChain({ stateAfter: state() }), T.policy, { setting: "slippageBps", value: "100" });
    await expect(p.finish(TX)).rejects.toThrow(/slippageBps reads 300/);
  });
});

describe("automation", () => {
  const off = () => state({ status: { interval: 0n, pendingSchedule: ZERO, nextRunAt: 0n } });

  it("start_automation builds startAutomation(interval) for the owner when it is off", async () => {
    const out = await run(stubChain({ state: off() }), T.start, { intervalSeconds: 3600 });
    expect(decode(out).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "startAutomation", args: [3600n] }));
  });
  it("start_automation refuses when already on, when not owner, and when the engine cannot pay the booking", async () => {
    expect((await run(stubChain(), T.start, { intervalSeconds: 3600 })).raw.reasons[0]).toContain("already on, every 2100s");
    expect((await run(stubChain({ evm: STRANGER, state: off() }), T.start, { intervalSeconds: 3600 })).raw.reasons[0]).toContain("Only the engine owner");
    const poor = await run(stubChain({ state: state({ status: { interval: 0n, pendingSchedule: ZERO, nextRunAt: 0n, balance: 100_000_000n } }) }), T.start, { intervalSeconds: 3600 });
    expect(poor.raw.reasons[0]).toContain("gas reservation");
    expect((await run(stubChain({ state: off() }), T.start, { intervalSeconds: 30 })).raw.status).toBe("ERROR");
  });
  it("start_automation proves the interval and a future pending schedule", async () => {
    const after = state({ status: { interval: 3600n, nextRunAt: 1_791_144_671n } });
    const done = await (await plan(stubChain({ state: off(), stateAfter: after }), T.start, { intervalSeconds: 3600 })).finish(TX);
    expect(done.raw).toMatchObject({ intervalSeconds: 3600, pendingSchedule: SCHEDULE, nextRunAtIso: "2026-10-04T20:11:11.000Z" });
    const unchanged = await plan(stubChain({ state: off(), stateAfter: off() }), T.start, { intervalSeconds: 3600 });
    await expect(unchanged.finish(TX)).rejects.toThrow(/startAutomation returned/);
  });

  it("stop_automation builds stopAutomation, and is a no-op when already off", async () => {
    expect(decode(await run(stubChain(), T.stop, {})).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "stopAutomation" }));
    expect((await run(stubChain({ state: off() }), T.stop, {})).raw).toMatchObject({ noop: true });
    expect((await run(stubChain({ evm: STRANGER }), T.stop, {})).raw.blocked).toBe(true);
  });
  it("stop_automation proves the interval and schedule read as cleared", async () => {
    const done = await (await plan(stubChain({ stateAfter: off() }), T.stop, {})).finish(TX);
    expect(done.raw.deletedSchedule).toBe(SCHEDULE);
    await expect((await plan(stubChain({ stateAfter: state() }), T.stop, {})).finish(TX)).rejects.toThrow(/stopAutomation returned/);
  });

  it("rearm_automation is open to anyone once a booked run is more than the grace period late", async () => {
    const dead = state({ status: { nextRunAt: 1_791_140_000n } });
    const out = await run(stubChain({ evm: STRANGER, state: dead }), T.rearm, {});
    expect(decode(out).data).toBe(encodeFunctionData({ abi: engineAbi, functionName: "rearm" }));
  });
  it("rearm_automation builds for an orphaned chain", async () => {
    const out = await run(stubChain({ state: state({ status: { pendingSchedule: ZERO, nextRunAt: 0n } }) }), T.rearm, {});
    expect(out.bytes).toBeDefined();
  });
  it("rearm_automation does nothing while a run is live, inside the grace period, or when automation is off", async () => {
    expect((await run(stubChain(), T.rearm, {})).raw).toMatchObject({ noop: true });
    const grace = await run(stubChain({ state: state({ status: { nextRunAt: 1_791_140_700n } }) }), T.rearm, {});
    expect(grace.raw.reason).toContain("grace period");
    expect((await run(stubChain({ state: state({ status: { interval: 0n, pendingSchedule: ZERO, nextRunAt: 0n } }) }), T.rearm, {})).raw.reason).toContain("off");
  });
  it("rearm_automation blocks when the engine cannot pay the booking", async () => {
    const out = await run(stubChain({ state: state({ status: { pendingSchedule: ZERO, nextRunAt: 0n, balance: 1n } }) }), T.rearm, {});
    expect(out.raw).toMatchObject({ status: "ERROR", blocked: true });
  });
  it("rearm_automation proves a new schedule replaced the stale one", async () => {
    const dead = state({ status: { nextRunAt: 1_791_140_000n } });
    const fresh = state({ status: { pendingSchedule: "0x0000000000000000000000000000000000A5B999", nextRunAt: 1_791_143_000n } });
    const done = await (await plan(stubChain({ state: dead, stateAfter: fresh }), T.rearm, {})).finish(TX);
    expect(done.raw).toMatchObject({ staleSchedule: SCHEDULE, pendingSchedule: "0x0000000000000000000000000000000000A5B999" });
    await expect((await plan(stubChain({ state: dead, stateAfter: dead }), T.rearm, {})).finish(TX)).rejects.toThrow(/rearm\(\) returned/);
  });
});

describe("configuration", () => {
  it("targets the engine named by FURNACE_ENGINE", () => {
    expect(configFromEnv({ FURNACE_ENGINE: ENGINE }).engine).toBe(ENGINE);
  });
});
