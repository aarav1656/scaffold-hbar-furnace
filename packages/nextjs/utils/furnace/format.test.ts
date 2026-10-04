import {
  fmtAgo,
  fmtBps,
  fmtDuration,
  fmtShare,
  fmtUnits,
  fmtUsd,
  fmtUsdPrice,
  parseAmount,
  shortAddress,
} from "./format";
import { describe, expect, it } from "vitest";

describe("fmtUnits", () => {
  it("prints the exact digits of a balance a float would round", () => {
    expect(fmtUnits(12345678912345679n, 8, 8)).toBe("123,456,789.12345679");
    // above 2^53 a Number cannot hold this amount, so the function must not go through one
    expect(BigInt(Number(12345678912345679n))).not.toBe(12345678912345679n);
  });

  it("trims trailing zeros by default and keeps them with pad", () => {
    expect(fmtUnits(150_000_000n, 8)).toBe("1.5");
    expect(fmtUnits(150_000_000n, 8, 4, true)).toBe("1.5000");
    expect(fmtUnits(100_000_000n, 8)).toBe("1");
    expect(fmtUnits(0n, 8)).toBe("0");
    expect(fmtUnits(0n, 8, 2, true)).toBe("0.00");
  });

  it("rounds half up on the last shown digit", () => {
    expect(fmtUnits(123_455_000n, 8, 4)).toBe("1.2346");
    expect(fmtUnits(123_454_999n, 8, 4)).toBe("1.2345");
  });

  it("carries a round-up into the whole part", () => {
    expect(fmtUnits(99_999_999n, 8, 4)).toBe("1");
    expect(fmtUnits(99_999_999n, 8, 4, true)).toBe("1.0000");
    expect(fmtUnits(999_999_999_999n, 8, 2, true)).toBe("10,000.00");
  });

  it("groups thousands", () => {
    expect(fmtUnits(100_000_000_000_000n, 8)).toBe("1,000,000");
    expect(fmtUnits(123_456_700_000_000n, 8)).toBe("1,234,567");
  });

  it("marks a nonzero amount below the shown precision instead of printing zero", () => {
    expect(fmtUnits(1n, 8, 4)).toBe("<0.0001");
    expect(fmtUnits(4_999n, 8, 4)).toBe("<0.0001");
    expect(fmtUnits(5_000n, 8, 4)).toBe("0.0001");
    expect(fmtUnits(1n, 8, 1)).toBe("<0.1");
  });

  it("signs negatives", () => {
    expect(fmtUnits(-150_000_000n, 8)).toBe("-1.5");
    expect(fmtUnits(-123_456_789_000n, 8, 2, true)).toBe("-1,234.57");
  });

  it("handles fewer decimals than digits and zero decimals", () => {
    expect(fmtUnits(5n, 0, 4)).toBe("5");
    expect(fmtUnits(1234n, 0)).toBe("1,234");
    expect(fmtUnits(250n, 2, 4)).toBe("2.5");
  });
});

describe("fmtUsd and fmtUsdPrice", () => {
  it("shows contract USD (8 decimals) with two padded places", () => {
    expect(fmtUsd(100_000_000n)).toBe("$1.00");
    expect(fmtUsd(1_234_567_890n)).toBe("$12.35");
    expect(fmtUsd(0n)).toBe("$0.00");
  });

  it("keeps every digit of a sub-cent token price", () => {
    expect(fmtUsdPrice(1123n)).toBe("$0.00001123");
    expect(fmtUsdPrice(663n)).toBe("$0.00000663");
  });

  it("switches to four places at one cent", () => {
    expect(fmtUsdPrice(999_999n)).toBe("$0.00999999");
    expect(fmtUsdPrice(1_000_000n)).toBe("$0.0100");
    expect(fmtUsdPrice(123_456_789n)).toBe("$1.2346");
  });
});

describe("fmtDuration and fmtAgo", () => {
  it.each([
    [0, "0s"],
    [59, "59s"],
    [59.9, "59s"],
    [60, "1m"],
    [61, "1m 1s"],
    [600, "10m"],
    [601, "10m"],
    [3600, "1h"],
    [3660, "1h 1m"],
    [21600, "6h"],
    [86400, "1d"],
    [90000, "1d 1h"],
    [-5, "0s"],
  ])("%s seconds is %s", (seconds, text) => {
    expect(fmtDuration(seconds)).toBe(text);
  });

  it("appends ago", () => {
    expect(fmtAgo(3660)).toBe("1h 1m ago");
  });
});

describe("shortAddress", () => {
  it("keeps six leading and four trailing characters", () => {
    expect(shortAddress("0x1565aF2C2eF52b4A89180684a47C5260c716AbD1")).toBe("0x1565…AbD1");
  });
});

describe("parseAmount", () => {
  it("converts decimals to base units exactly", () => {
    expect(parseAmount("1.5", 8)).toBe(150_000_000n);
    expect(parseAmount("0.00000001", 8)).toBe(1n);
    expect(parseAmount("123456789.12345678", 8)).toBe(12345678912345678n);
    expect(parseAmount("2", 8)).toBe(200_000_000n);
    expect(parseAmount(".5", 8)).toBe(50_000_000n);
    expect(parseAmount("5.", 8)).toBe(500_000_000n);
    expect(parseAmount("  2  ", 8)).toBe(200_000_000n);
    expect(parseAmount("0", 8)).toBe(0n);
  });

  it("rejects input finer than the token, rather than rounding it", () => {
    expect(parseAmount("0.000000001", 8)).toBeNull();
    expect(parseAmount("1.5", 0)).toBeNull();
    expect(parseAmount("1", 0)).toBe(1n);
  });

  it.each(["", " ", ".", "abc", "-1", "1e5", "1.2.3", "1,5", "0x10", "+1"])("rejects %j", text => {
    expect(parseAmount(text, 8)).toBeNull();
  });

  it("round-trips through fmtUnits", () => {
    for (const text of ["1", "1.5", "0.00000001", "123456789.12345678", "999.99999999"]) {
      const units = parseAmount(text, 8);
      expect(units).not.toBeNull();
      expect(fmtUnits(units!, 8, 8).replace(/,/g, "")).toBe(text);
    }
  });
});

describe("fmtShare", () => {
  it("computes the share from bigints, truncating", () => {
    expect(fmtShare(1n, 3n)).toBe("33.33%");
    expect(fmtShare(2n, 3n)).toBe("66.66%");
    expect(fmtShare(1n, 1n)).toBe("100.00%");
    expect(fmtShare(0n, 5n)).toBe("0.00%");
    expect(fmtShare(33n, 100n, 0)).toBe("33%");
  });

  it("returns 0% for an empty denominator", () => {
    expect(fmtShare(5n, 0n)).toBe("0%");
  });

  it("matches the live burn: 1,544,308,541,588 of 100,000,000,000,000 base units", () => {
    expect(fmtShare(1_544_308_541_588n, 100_000_000_000_000n)).toBe("1.54%");
  });
});

describe("fmtBps", () => {
  it.each([
    [500, "5%"],
    [350, "3.5%"],
    [25, "0.25%"],
    [1, "0.01%"],
    [0, "0%"],
    [10_000n, "100%"],
  ])("%s bps is %s", (bps, text) => {
    expect(fmtBps(bps)).toBe(text);
  });
});
