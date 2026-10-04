import { LIVE_LOGS, LIVE_TOKEN } from "./__fixtures__";
import { stubMirrorLogs } from "./__fixtures__/stub";
import { type EngineEvent, fetchEngineEvents } from "./mirror";
import { supplySeries } from "./supply";
import { beforeAll, describe, expect, it } from "vitest";

let events: EngineEvent[];
beforeAll(async () => {
  stubMirrorLogs(LIVE_LOGS);
  events = (await fetchEngineEvents("0x706947eCC0411bAdeF790282bb89b80126357D9D")).events;
});

const NOW = 1_791_200_000;
const SUPPLY_AFTER = [
  98_005_700_860_434n,
  96_110_832_443_647n,
  94_310_437_392_631n,
  92_599_805_502_743n,
  90_974_461_399_332n,
  89_430_152_857_744n,
];

describe("supplySeries on the live engine history", () => {
  it("steps from creation through each burn to the current total, oldest first", () => {
    const points = supplySeries(events, LIVE_TOKEN, NOW, true);
    expect(points).toHaveLength(8);
    expect(points[0]).toEqual({ t: Number(LIVE_TOKEN.created_timestamp), supply: 100_000_000_000_000n });
    expect(points.slice(1, 7).map(p => p.supply)).toEqual(SUPPLY_AFTER);
    expect(points[7]).toEqual({ t: NOW, supply: 89_430_152_857_744n });
    const times = points.map(p => p.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("carries the burn payload with the right field in the right slot", () => {
    const points = supplySeries(events, LIVE_TOKEN, NOW, true);
    expect(points[6].burn).toEqual({
      tokens: 1_544_308_541_588n,
      hbar: 170_046_767n,
      hash: "0x89b58bc1fa5b44c0d90306395537c700cde073c0c4b1d79bb0d436dbde9c4b0d",
      priceUsd: 1123n,
    });
    expect(points[0].burn).toBeUndefined();
    expect(points[7].burn).toBeUndefined();
  });

  it("agrees with the chain: each supplyAfter is the initial supply minus every burn so far", () => {
    const burns = supplySeries(events, LIVE_TOKEN, NOW, true).filter(p => p.burn);
    expect(burns).toHaveLength(6);
    let supply = BigInt(LIVE_TOKEN.initial_supply);
    for (const p of burns) {
      supply -= p.burn!.tokens;
      expect(p.supply).toBe(supply);
    }
    expect(supply).toBe(BigInt(LIVE_TOKEN.total_supply));
  });

  it("counts a burn once even though the same run also logs ScheduledRun with the same amount", () => {
    expect(events.filter(e => e.name === "ScheduledRun")).toHaveLength(5);
    expect(supplySeries(events, LIVE_TOKEN, NOW, true).filter(p => p.burn)).toHaveLength(6);
  });

  it("drops the creation point when history is incomplete", () => {
    const points = supplySeries(events, LIVE_TOKEN, NOW, false);
    expect(points).toHaveLength(7);
    expect(points[0].supply).toBe(SUPPLY_AFTER[0]);
  });

  it("never plots the current total before the last burn", () => {
    const lastBurn = Number(events.find(e => e.name === "Burned")!.timestamp);
    const points = supplySeries(events, LIVE_TOKEN, 1_000, true);
    expect(points[points.length - 1].t).toBe(lastBurn);
  });

  it("gives a token with no burns a creation point and a current point", () => {
    expect(supplySeries([], LIVE_TOKEN, NOW, true)).toEqual([
      { t: Number(LIVE_TOKEN.created_timestamp), supply: 100_000_000_000_000n },
      { t: NOW, supply: 89_430_152_857_744n },
    ]);
    expect(supplySeries([], LIVE_TOKEN, NOW, false)).toEqual([{ t: NOW, supply: 89_430_152_857_744n }]);
  });
});
