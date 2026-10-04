import { ENGINE, LIVE_LOGS } from "./__fixtures__";
import { stubMirrorLogs } from "./__fixtures__/stub";
import { ENGINE_ABI } from "./constants";
import { type MirrorLog, fetchEngineEvents } from "./mirror";
import { UNTAGGED, revenueBySource, sourceLabel } from "./revenue";
import { type Hex, encodeAbiParameters, encodeEventTopics, pad, stringToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const taggedLog = (label: string, from: Hex, amount: bigint, index: number): MirrorLog => ({
  topics: encodeEventTopics({
    abi: ENGINE_ABI,
    eventName: "RevenueTagged",
    args: { source: pad(stringToHex(label), { dir: "right", size: 32 }), from },
  }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  index,
  timestamp: `1791300000.00000000${index}`,
  transaction_hash: `0x${String(index).repeat(64)}` as Hex,
});

describe("revenue by source", () => {
  it("reads a bytes32 label as text and leaves anything else as hex", () => {
    expect(sourceLabel(pad(stringToHex("swap-fees"), { dir: "right", size: 32 }))).toBe("swap-fees");
    const binary = `0x${"ff".repeat(32)}` as Hex;
    expect(sourceLabel(binary)).toBe(binary);
  });

  it("totals the live plain transfers as one untagged stream", async () => {
    stubMirrorLogs(LIVE_LOGS);
    const { events } = await fetchEngineEvents(ENGINE);
    const plain = events.filter(e => e.name === "RevenueReceived");
    expect(plain).toHaveLength(2);
    const expected = plain.reduce((sum, e) => sum + (e.args as { amount: bigint }).amount, 0n);
    expect(expected).toBeGreaterThan(0n);
    expect(revenueBySource(events)).toEqual([{ source: UNTAGGED, amount: expected, deposits: 2 }]);
  });

  it("splits tagged deposits by label next to the untagged stream, largest first", async () => {
    const from = "0x11Cf661848D52aEdF638658E6b68762549f74a0C" as Hex;
    stubMirrorLogs([
      ...LIVE_LOGS,
      taggedLog("swap-fees", from, 4_000_000_000n, 1),
      taggedLog("swap-fees", from, 500_000_000n, 2),
      taggedLog("bridge-fees", from, 7_000_000_000n, 3),
    ]);
    const { events } = await fetchEngineEvents(ENGINE);
    const rows = revenueBySource(events);
    expect(rows.map(r => r.source)).toEqual(["bridge-fees", "swap-fees", UNTAGGED]);
    expect(rows[0]).toEqual({ source: "bridge-fees", amount: 7_000_000_000n, deposits: 1 });
    expect(rows[1]).toEqual({ source: "swap-fees", amount: 4_500_000_000n, deposits: 2 });
  });
});
