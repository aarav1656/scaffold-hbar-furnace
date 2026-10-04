import {
  ENGINE_ABI,
  ENGINE_ADDRESS,
  GAS_CAP,
  GAS_FLOOR,
  HTS_ALREADY_ASSOCIATED,
  HTS_SUCCESS,
  IS_DEPLOYED,
  SKIP_REASONS,
  SKIP_TEXT,
  TINYBAR_DECIMALS,
  USD_DECIMALS,
  WEIBAR_PER_TINYBAR,
} from "./constants";
import { fmtUnits } from "./format";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("HBAR units", () => {
  it("counts 10^10 weibar in a tinybar, so 1 HBAR is 10^8 tinybar and 10^18 weibar", () => {
    expect(TINYBAR_DECIMALS).toBe(8);
    expect(WEIBAR_PER_TINYBAR).toBe(10n ** BigInt(18 - TINYBAR_DECIMALS));
    const oneHbarTinybar = 10n ** BigInt(TINYBAR_DECIMALS);
    expect(oneHbarTinybar * WEIBAR_PER_TINYBAR).toBe(10n ** 18n);
  });

  it("shows engine tinybar and a wallet's weibar as the same HBAR", () => {
    const revenueTinybar = 3_500_000_000n; // RevenueReceived on the live engine
    expect(fmtUnits(revenueTinybar, TINYBAR_DECIMALS)).toBe("35");
    expect(fmtUnits(revenueTinybar * WEIBAR_PER_TINYBAR, 18)).toBe("35");
    expect(fmtUnits(170_046_767n, TINYBAR_DECIMALS, 8)).toBe("1.70046767");
  });

  it("keeps USD and the FURN token at 8 decimals", () => {
    expect(USD_DECIMALS).toBe(8);
    expect(fmtUnits(1_544_308_541_588n, 8)).toBe("15,443.0854");
  });
});

describe("Skip enum", () => {
  it("lists the reasons in the order the Solidity enum declares them", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../foundry/contracts/FurnaceEngine.sol"), "utf8");
    const body = /enum Skip\s*\{([^}]*)\}/.exec(source)![1];
    const declared = body
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(1);
    expect([...SKIP_REASONS]).toEqual(declared);
  });

  it("has one sentence per reason", () => {
    expect(Object.keys(SKIP_TEXT).sort()).toEqual([...SKIP_REASONS].sort());
    for (const text of Object.values(SKIP_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe("gas and deployment constants", () => {
  it("keeps every floor positive and under the cap", () => {
    for (const [name, floor] of Object.entries(GAS_FLOOR)) {
      expect(floor, name).toBeGreaterThan(0n);
      expect(floor, name).toBeLessThanOrEqual(GAS_CAP);
    }
  });

  it("uses the HTS success and already-associated response codes", () => {
    expect(HTS_SUCCESS).toBe(22n);
    expect(HTS_ALREADY_ASSOCIATED).toBe(194n);
  });

  it("points at a deployed engine whose ABI carries the events the page decodes", () => {
    expect(IS_DEPLOYED).toBe(true);
    expect(ENGINE_ADDRESS.toLowerCase()).toBe("0x3249617e95785640140a05f55fd9c798f0e116df");
    const events = ENGINE_ABI.filter(i => i.type === "event").map(i => i.name);
    for (const name of ["Burned", "ScheduledRun", "BuybackSkipped", "RunBooked", "RevenueReceived"]) {
      expect(events).toContain(name);
    }
  });
});
