import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY, POLICY_NAMES, SKIPS, fuelRunway, nextRun, policyArg, previewInfo, setterName, skipInfo, splitBurns } from "../src/analysis";
import { decodeRevert } from "../src/chain";
import { configFromEnv, hasFunction, parseDeployed } from "../src/config";
import { entityNum, linkBuilder, mirrorTxId } from "../src/links";
import { buybackNowSchema, sendRevenueSchema, setPolicySchema, startAutomationSchema } from "../src/schemas";
import { shapeState } from "../src/shape";
import { parseAmount } from "../src/units";
import { SCHEDULE, ZERO, cfg, ledger, state } from "./fixture";
import { encodeErrorResult } from "viem";
import { engineAbi } from "../src/abi";

describe("amounts", () => {
  it("parses plain decimals to 8-decimal integers", () => {
    expect(parseAmount("1")).toBe(100_000_000n);
    expect(parseAmount("0.00000001")).toBe(1n);
  });
  it.each(["0", "0.0", "-1", "1e3", "1.123456789", "", "abc", "1,5", " ", "0x10"])("refuses %j", (bad) => {
    expect(() => parseAmount(bad)).toThrow();
  });
  it("allows zero only when asked", () => {
    expect(parseAmount("0", "x", true)).toBe(0n);
  });
});

describe("deployedContracts.ts", () => {
  const sample = `const deployedContracts = { 296: { FurnaceEngine: { address: "0x3249617e95785640140a05f55fd9c798f0e116df", abi: [ { type: "function", name: "status", inputs: [] }, { type: "function", name: "rearm" }, { type: "event", name: "Burned" } ], inheritedFunctions: {} } } }`;

  it("reads the engine address and the function names, not events", () => {
    const d = parseDeployed(sample);
    expect(d.engine).toBe("0x3249617e95785640140a05f55fd9c798f0e116df");
    expect([...d.functions].sort()).toEqual(["rearm", "status"]);
  });

  it("follows a redeploy: a new address in the file is the new engine", () => {
    const next = sample.replace("3249617e95785640140a05f55fd9c798f0e116df", "00000000000000000000000000000000000000aa");
    expect(configFromEnv({}, () => next).engine).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("reads the checked-in file of this repo", () => {
    const c = configFromEnv({});
    expect(c.engine).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (const fn of ["status", "previewBuyback", "buyback", "depositRevenue", "rearm", "startAutomation", "stopAutomation", ...POLICY_NAMES.map(setterName)]) expect(hasFunction(c, fn)).toBe(true);
    const onChain = readFileSync(new URL("../../packages/nextjs/contracts/deployedContracts.ts", import.meta.url), "utf8");
    expect(onChain.toLowerCase()).toContain(c.engine.toLowerCase());
  });

  it("refuses a file with no entry for chain 296 and a bad FURNACE_ENGINE", () => {
    expect(() => parseDeployed(`{ 31337: { FurnaceEngine: { address: "0x3249617e95785640140a05f55fd9c798f0e116df" } } }`)).toThrow(/chain 296/);
    expect(() => configFromEnv({ FURNACE_ENGINE: "0x12" })).toThrow(/not an EVM address/);
    expect(() => configFromEnv({}, () => { throw new Error("ENOENT"); })).toThrow(/FURNACE_ENGINE/);
  });

  it("FURNACE_ENGINE wins and assumes the current engine has every function", () => {
    const c = configFromEnv({ FURNACE_ENGINE: "0x00000000000000000000000000000000000000bb" }, () => { throw new Error("must not read"); });
    expect(c.abiFunctions).toBeNull();
    expect(hasFunction(c, "depositRevenue")).toBe(true);
  });
});

describe("skip reasons", () => {
  it("names all eleven FurnaceEngine.Skip values in order", () => {
    expect(SKIPS.map((s) => s[0])).toEqual(["None", "NotReady", "NoFunds", "BudgetSpent", "PriceCeiling", "ImpactCap", "TooSoon", "LotCap", "NoTwap", "TwapWindow", "TwapDeviation"]);
    expect(skipInfo(3)).toMatchObject({ name: "BudgetSpent" });
    expect(() => skipInfo(11)).toThrow();
  });
  it("treats a stale oracle as its own outcome", () => {
    expect(previewInfo({ ok: false, reason: "StaleOracle" })).toMatchObject({ wouldSpend: false, spend: 0n, skip: { code: -1, name: "StaleOracle" } });
    expect(previewInfo({ ok: true, skip: 0, spend: 5n })).toMatchObject({ wouldSpend: true, spend: 5n });
    expect(previewInfo({ ok: true, skip: 2, spend: 0n }).wouldSpend).toBe(false);
  });
});

describe("network versus manual burns", () => {
  const burn = (timestamp: string, tokensBurned: bigint) => ({ timestamp, tokensBurned, hbarIn: tokensBurned / 10n });
  it("counts a burn as the network's only when ScheduledRun came in the same transaction", () => {
    const split = splitBurns([burn("1.1", 100n), burn("2.2", 200n), burn("3.3", 300n)], new Set(["1.1", "3.3", "9.9"]));
    expect(split.network).toEqual({ burns: 2, tokensBurned: 400n, hbarSpent: 40n });
    expect(split.manual).toEqual({ burns: 1, tokensBurned: 200n, hbarSpent: 20n });
  });
  it("counts every burn as manual when no scheduled run ever happened", () => {
    expect(splitBurns([burn("1.1", 5n)], new Set()).network.burns).toBe(0);
  });
});

describe("policy bounds", () => {
  it("converts USD to 8 decimals and accepts the contract's limits", () => {
    expect(policyArg("dailyBudgetUsd", "5")).toBe(500_000_000n);
    expect(policyArg("dailyBudgetUsd", "0")).toBe(0n);
    expect(policyArg("priceCeilingUsd", "0.3")).toBe(30_000_000n);
    expect(policyArg("maxLotUsd", "0.1")).toBe(10_000_000n);
    expect(policyArg("maxLotUsd", "0")).toBe(0n);
    expect(policyArg("maxImpactBps", "1000")).toBe(1000n);
    expect(policyArg("slippageBps", "0")).toBe(0n);
    expect(policyArg("minGapSeconds", "86400")).toBe(86_400n);
    expect(policyArg("maxTwapDeviationBps", "50")).toBe(50n);
  });
  it.each([
    ["maxImpactBps", "0"],
    ["maxImpactBps", "1001"],
    ["slippageBps", "1001"],
    ["minGapSeconds", "86401"],
    ["maxTwapDeviationBps", "49"],
    ["maxTwapDeviationBps", "2001"],
    ["maxLotUsd", "0.09"],
    ["dailyBudgetUsd", "-1"],
    ["dailyBudgetUsd", "1.123456789"],
    ["slippageBps", "1.5"],
    ["priceCeilingUsd", "99999999999999999999"],
  ])("refuses %s = %s, the values the contract reverts BadConfig on", (setting, value) => {
    expect(() => policyArg(setting as never, value)).toThrow();
  });
  it("covers exactly the seven setters the engine has", () => {
    expect(POLICY_NAMES.map(setterName)).toEqual(["setDailyBudgetUsd", "setPriceCeilingUsd", "setMaxLotUsd", "setMaxImpactBps", "setSlippageBps", "setMinGapSeconds", "setMaxTwapDeviationBps"]);
    expect(Object.keys(POLICY)).toHaveLength(7);
  });
});

describe("automation and fuel", () => {
  it("reads off, scheduled, past due and orphaned", () => {
    expect(nextRun(0n, ZERO, 0n, 1000, 600n).status).toBe("off");
    expect(nextRun(2100n, ZERO, 0n, 1000, 600n)).toMatchObject({ status: "orphaned", rearmable: true });
    expect(nextRun(2100n, SCHEDULE, 1300n, 1000, 600n)).toMatchObject({ status: "scheduled", secondsUntil: 300, rearmable: false });
    expect(nextRun(2100n, SCHEDULE, 900n, 1000, 600n)).toMatchObject({ status: "past_due", secondsUntil: -100, rearmable: false });
  });
  it("lets anyone rearm only once the grace period has passed", () => {
    expect(nextRun(2100n, SCHEDULE, 400n, 1000, 600n).rearmable).toBe(false);
    expect(nextRun(2100n, SCHEDULE, 399n, 1000, 600n).rearmable).toBe(true);
  });
  it("counts runs from the real fee when known, and from the reservation otherwise", () => {
    const withFee = fuelRunway(2_500_000_000n, 2_500_000_000n, 4_000_000n, 870_000_000_000n, 141_794_436n, 2100n);
    expect(withFee).toMatchObject({ fuelHbar: "25", reservationHbar: "3.48", lastRunCostHbar: "1.41794436", runsCovered: 16, basis: "last-run-cost" });
    const without = fuelRunway(2_500_000_000n, 2_500_000_000n, 4_000_000n, 870_000_000_000n, null, 2100n);
    expect(without).toMatchObject({ runsCovered: 7, basis: "reservation-only" });
  });
  it("counts only the protected reserve as fuel, and zero runs below the reservation", () => {
    expect(fuelRunway(10_000_000_000n, 2_500_000_000n, 4_000_000n, 870_000_000_000n, null, 2100n).fuelHbar).toBe("25");
    expect(fuelRunway(100_000_000n, 2_500_000_000n, 4_000_000n, 870_000_000_000n, null, 2100n).runsCovered).toBe(0);
    expect(fuelRunway(100_000_000n, 2_500_000_000n, 4_000_000n, 870_000_000_000n, null, 0n).daysCovered).toBeNull();
  });
});

describe("shapeState", () => {
  it("reports supply, burn split, budget in USD and HBAR, policy and links from the live-shaped numbers", () => {
    const s = shapeState(state(), ledger(), cfg());
    expect(s.token).toMatchObject({ symbol: "FURN", totalSupply: "988661.56743165" });
    expect(s.burned).toMatchObject({ totalBurned: "11338.43256835", burns: { network: 3, manual: 1 }, mirrorReconciled: true, percentOfSupplyBurned: "1.13" });
    expect(s.budget).toMatchObject({ dailyUsd: "5", leftUsd: "4.7", leftHbar: "45.55452309", oracle: "fresh" });
    expect(s.policy).toMatchObject({ priceCeilingUsd: "0.3", maxLotUsd: "1", minGapSeconds: 900, anyoneMayTrigger: true });
    expect(s.spendableHbar).toBe("77.92608047");
    expect(s.nextBurn).toMatchObject({ status: "scheduled", secondsUntil: 294 });
    expect(s.buyback).toMatchObject({ wouldSpend: true, spendHbar: "2.90773551" });
    expect(s.links.engine).toBe("https://hashscan.io/testnet/contract/0x3249617e95785640140a05f55fd9c798f0e116df");
    expect(s.links.token).toBe("https://hashscan.io/testnet/token/0.0.10860654");
    expect(s.links.pendingSchedule).toBe("https://hashscan.io/testnet/schedule/0.0.10860804");
  });
  it("shows no HBAR budget when the oracle is stale, and no burn split when the mirror was not read", () => {
    const s = shapeState(state({ status: { hbarUsd: 0n }, preview: { ok: false, reason: "StaleOracle" } }), null, cfg());
    expect(s.budget).toMatchObject({ leftHbar: null, hbarUsd: null, oracle: "stale" });
    expect(s.burned.burns).toBeNull();
    expect(s.buyback.skip.name).toBe("StaleOracle");
  });
  it("shows no ceiling or lot cap as null, not as zero dollars", () => {
    const s = shapeState(state({ policy: { priceCeilingUsd: 0n, maxLotUsd: 0n } }), null, cfg());
    expect(s.policy).toMatchObject({ priceCeilingUsd: null, maxLotUsd: null });
  });
});

describe("input schemas", () => {
  it("accepts numbers and strings for amounts and refuses zero, junk and over-precise values", () => {
    expect(sendRevenueSchema.parse({ hbar: 1.5 }).hbar).toBe("1.5");
    expect(sendRevenueSchema.parse({ hbar: " 2 ", source: "swap-fees" })).toEqual({ hbar: "2", source: "swap-fees" });
    for (const hbar of ["0", "-1", "1e3", "0.123456789", "abc", ""]) expect(sendRevenueSchema.safeParse({ hbar }).success).toBe(false);
  });
  it("bounds the revenue label to 32 printable ASCII characters", () => {
    expect(sendRevenueSchema.safeParse({ hbar: "1", source: "x".repeat(33) }).success).toBe(false);
    expect(sendRevenueSchema.safeParse({ hbar: "1", source: "" }).success).toBe(false);
    expect(sendRevenueSchema.safeParse({ hbar: "1", source: "café" }).success).toBe(false);
  });
  it("validates the policy setting name and the automation interval", () => {
    expect(setPolicySchema.safeParse({ setting: "owner", value: "1" }).success).toBe(false);
    expect(setPolicySchema.parse({ setting: "slippageBps", value: 100 }).value).toBe("100");
    expect(startAutomationSchema.safeParse({ intervalSeconds: 59 }).success).toBe(false);
    expect(startAutomationSchema.safeParse({ intervalSeconds: 5_184_001 }).success).toBe(false);
    expect(startAutomationSchema.safeParse({ intervalSeconds: 60 }).success).toBe(true);
    expect(buybackNowSchema.parse({}).force).toBe(false);
  });
});

describe("links and reverts", () => {
  it("turns SDK transaction ids into mirror node ids and long-zero addresses into entities", () => {
    expect(mirrorTxId("0.0.123@1700000000.000000001")).toBe("0.0.123-1700000000-000000001");
    expect(() => mirrorTxId("nope")).toThrow();
    expect(entityNum("0x0000000000000000000000000000000000a5B86E")).toBe(10860654);
    expect(entityNum("0x3249617e95785640140a05f55fd9c798f0e116df")).toBeNull();
    expect(linkBuilder("https://h").tx("0.0.1@2.3")).toBe("https://h/transaction/0.0.1-2-3");
  });
  it("decodes the engine's own revert from the mirror node's bytes", () => {
    expect(decodeRevert(encodeErrorResult({ abi: engineAbi, errorName: "BuybackRefused", args: [3] }))).toEqual({ name: "BuybackRefused", args: ["3"] });
    expect(decodeRevert(encodeErrorResult({ abi: engineAbi, errorName: "NotOwnerOrSelf" }))).toEqual({ name: "NotOwnerOrSelf", args: [] });
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert(null)).toBeNull();
  });
});
