import { ENGINE, LIVE_LOGS, LIVE_TOKEN, jsonResponse } from "./__fixtures__";
import { stubMirrorLogs } from "./__fixtures__/stub";
import { SKIP_REASONS, SKIP_TEXT } from "./constants";
import { ENGINE_ABI } from "./constants";
import {
  MIRROR_URL,
  MirrorError,
  type MirrorLog,
  fetchAssociation,
  fetchEngineEvents,
  fetchRunFee,
  fetchTokenInfo,
  waitForContractResult,
} from "./mirror";
import { type Hex, encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = () => vi.mocked(fetch);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchEngineEvents: decoding the live engine history", () => {
  beforeEach(() => void stubMirrorLogs(LIVE_LOGS));

  it("decodes every one of the 29 logs, newest first", async () => {
    const { events, complete } = await fetchEngineEvents(ENGINE);
    expect(complete).toBe(true);
    expect(events).toHaveLength(29);
    const count = (name: string) => events.filter(e => e.name === name).length;
    expect(count("Burned")).toBe(6);
    expect(count("ScheduledRun")).toBe(5);
    expect(count("RunBooked")).toBe(7);
    expect(count("RevenueReceived")).toBe(2);
    expect(count("OwnershipTransferred")).toBe(2);
    expect(count("AutomationStarted")).toBe(2);
    expect(events[0].name).toBe("ScheduledRun");
    expect(events[events.length - 1].name).toBe("OwnershipTransferred");
  });

  it("decodes Burned to the exact numbers on chain, each in its own slot", async () => {
    const { events } = await fetchEngineEvents(ENGINE);
    const burned = events.filter(e => e.name === "Burned");
    expect(burned[0].args).toEqual({
      hbarIn: 170_046_767n,
      tokensBurned: 1_544_308_541_588n,
      priceHbar: 11_011n,
      priceUsd: 1_123n,
      supplyAfter: 89_430_152_857_744n,
    });
    expect(burned[5].args).toEqual({
      hbarIn: 131_578_947n,
      tokensBurned: 1_994_299_139_566n,
      priceHbar: 6_597n,
      priceUsd: 663n,
      supplyAfter: 98_005_700_860_434n,
    });
  });

  it("decodes ScheduledRun to the same tokensBurned as the Burned log of that run", async () => {
    const { events } = await fetchEngineEvents(ENGINE);
    for (const run of events.filter(e => e.name === "ScheduledRun")) {
      const burn = events.find(e => e.name === "Burned" && e.hash === run.hash)!;
      expect(burn).toBeDefined();
      expect((run.args as { tokensBurned: bigint }).tokensBurned).toBe(
        (burn.args as { tokensBurned: bigint }).tokensBurned,
      );
    }
    expect(events[0].args).toEqual({ tokensBurned: 1_544_308_541_588n });
  });

  it("decodes the rest of the engine's events, including address and zero-argument ones", async () => {
    const { events } = await fetchEngineEvents(ENGINE);
    const by = (name: string) => events.filter(e => e.name === name);
    expect(by("Initialized")[0].args).toEqual({
      token: "0x0000000000000000000000000000000000A567E4",
      totalSupply: 100_000_000_000_000n,
      liquidityAllocation: 40_000_000_000_000n,
    });
    expect(by("RevenueReceived").map(e => e.args)).toEqual([
      { from: "0x9011817a249C8e1dF8044AFF148497a7225f5b91", amount: 100_000_000n },
      { from: "0x1565aF2C2eF52b4A89180684a47C5260c716AbD1", amount: 3_500_000_000n },
    ]);
    expect(by("AutomationStarted").map(e => e.args)).toEqual([{ interval: 21600n }, { interval: 180n }]);
    expect(by("AutomationStopped")[0].args).toEqual({});
    expect(by("LiquiditySeeded")[0].args).toEqual({
      tokenAmount: 40_000_000_000_000n,
      hbarAmount: 2_500_000_000n,
      lpMinted: 316_227_765_016n,
    });
  });

  it("builds the row id from transaction hash and log index, and the time from the consensus timestamp", async () => {
    const { events } = await fetchEngineEvents(ENGINE);
    const newest = events[0];
    expect(newest.id).toBe("0x89b58bc1fa5b44c0d90306395537c700cde073c0c4b1d79bb0d436dbde9c4b0d-19");
    expect(newest.hash).toBe("0x89b58bc1fa5b44c0d90306395537c700cde073c0c4b1d79bb0d436dbde9c4b0d");
    expect(newest.timestamp).toBe("1791107076.082884956");
    expect(newest.at).toBe(1_791_107_076);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
  });

  it("skips a log the engine ABI cannot decode, and a log with the right topic but corrupt data", async () => {
    const foreign: MirrorLog = { ...LIVE_LOGS[0], topics: [`0x${"ab".repeat(32)}`] as Hex[], index: 99 };
    const burned = LIVE_LOGS.find(l => l.topics[0].startsWith("0xe6d083b0c3"))!;
    const corrupt: MirrorLog = { ...burned, data: "0x1234", index: 98 };
    stubMirrorLogs([foreign, corrupt, ...LIVE_LOGS]);
    const { events } = await fetchEngineEvents(ENGINE);
    expect(events).toHaveLength(29);
    expect(events.some(e => e.id.endsWith("-99") || e.id.endsWith("-98"))).toBe(false);
  });

  it("decodes BuybackSkipped to each Skip reason, with text for every one", async () => {
    // No live skip exists in the engine's history, so these logs are encoded from the ABI the engine ships.
    const [topic] = encodeEventTopics({ abi: ENGINE_ABI, eventName: "BuybackSkipped" });
    const logs = SKIP_REASONS.map(
      (_, i): MirrorLog => ({
        topics: [topic],
        data: encodeAbiParameters([{ type: "uint8" }], [i]),
        index: i,
        timestamp: `1791200000.00000000${i}`,
        transaction_hash: `0x${String(i).repeat(64)}` as Hex,
      }),
    );
    stubMirrorLogs(logs);
    const { events } = await fetchEngineEvents(ENGINE);
    expect(events.map(e => e.name)).toEqual(Array(SKIP_REASONS.length).fill("BuybackSkipped"));
    const reasons = events.map(e => SKIP_REASONS[(e.args as { reason: number }).reason]);
    expect(reasons).toEqual([
      "None",
      "NotReady",
      "NoFunds",
      "BudgetSpent",
      "PriceCeiling",
      "ImpactCap",
      "TooSoon",
      "LotCap",
      "NoTwap",
      "TwapWindow",
      "TwapDeviation",
    ]);
    expect(SKIP_TEXT[reasons[4]]).toBe("The token price is at the USD ceiling.");
  });
});

describe("fetchEngineEvents: paging", () => {
  it("follows links.next with the /api/v1 prefix stripped, and keeps order across pages", async () => {
    const next = `/api/v1/contracts/${ENGINE}/results/logs?limit=100&order=desc&timestamp=lte:1791063880.037958663`;
    const mock = vi.fn(async (url: string) =>
      url.includes("timestamp=lte")
        ? jsonResponse({ logs: LIVE_LOGS.slice(10), links: { next: null } })
        : jsonResponse({ logs: LIVE_LOGS.slice(0, 10), links: { next } }),
    );
    vi.stubGlobal("fetch", mock);
    const { events, complete } = await fetchEngineEvents(ENGINE);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0][0]).toBe(`${MIRROR_URL}/api/v1/contracts/${ENGINE}/results/logs?order=desc&limit=100`);
    expect(mock.mock.calls[1][0]).toBe(`${MIRROR_URL}${next}`);
    expect(events).toHaveLength(29);
    expect(events[0].id).toContain("-19");
    expect(complete).toBe(true);
  });

  it("stops at 30 pages and reports the history as incomplete", async () => {
    const mock = vi.fn(async () =>
      jsonResponse({ logs: LIVE_LOGS.slice(0, 1), links: { next: "/api/v1/contracts/x/results/logs?page=more" } }),
    );
    vi.stubGlobal("fetch", mock);
    const { events, complete } = await fetchEngineEvents(ENGINE);
    expect(mock).toHaveBeenCalledTimes(30);
    expect(events).toHaveLength(30);
    expect(complete).toBe(false);
  });

  it("throws a MirrorError carrying the status when the node answers an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );
    await expect(fetchEngineEvents(ENGINE)).rejects.toMatchObject({ name: "Error", status: 503 });
    await expect(fetchEngineEvents(ENGINE)).rejects.toBeInstanceOf(MirrorError);
  });
});

describe("fetchAssociation", () => {
  const account = "0x1565aF2C2eF52b4A89180684a47C5260c716AbD1";
  const token = "0x0000000000000000000000000000000000A567E4";
  const respond = (routes: Record<string, unknown | number>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const key = Object.keys(routes).find(k => url.endsWith(k));
        if (!key) return jsonResponse({}, 404);
        const body = routes[key];
        return typeof body === "number" ? jsonResponse({}, body) : jsonResponse(body);
      }),
    );
  const REL = `/accounts/${account}/tokens?token.id=0.0.10840036`;

  it("asks the mirror node about the token's entity id, not its EVM address", async () => {
    respond({ [REL]: { tokens: [{ token_id: "0.0.10840036" }] } });
    expect(await fetchAssociation(account, token)).toBe("associated");
    expect(fetchMock().mock.calls[0][0]).toBe(`${MIRROR_URL}/api/v1${REL}`);
  });

  it("is not associated when the relationship list holds a different token", async () => {
    respond({
      [REL]: { tokens: [{ token_id: "0.0.10840037" }] },
      [`/accounts/${account}`]: { max_automatic_token_associations: 0 },
    });
    expect(await fetchAssociation(account, token)).toBe("needs");
  });

  it("reports auto only for unlimited automatic associations (-1)", async () => {
    respond({ [REL]: { tokens: [] }, [`/accounts/${account}`]: { max_automatic_token_associations: -1 } });
    expect(await fetchAssociation(account, token)).toBe("auto");
    respond({ [REL]: { tokens: [] }, [`/accounts/${account}`]: { max_automatic_token_associations: 0 } });
    expect(await fetchAssociation(account, token)).toBe("needs");
    // A finite allowance can be used up, so only the unlimited setting skips the explicit associate step.
    respond({ [REL]: { tokens: [] }, [`/accounts/${account}`]: { max_automatic_token_associations: 10 } });
    expect(await fetchAssociation(account, token)).toBe("needs");
  });

  it("throws, never guesses, when the lookup fails; an unknown account keeps its 404", async () => {
    respond({ [REL]: 500 });
    await expect(fetchAssociation(account, token)).rejects.toMatchObject({ status: 500 });
    respond({ [REL]: 404 });
    await expect(fetchAssociation(account, token)).rejects.toMatchObject({ status: 404 });
    respond({ [REL]: { tokens: [] }, [`/accounts/${account}`]: 429 });
    await expect(fetchAssociation(account, token)).rejects.toMatchObject({ status: 429 });
  });
});

describe("fetchTokenInfo and fetchRunFee", () => {
  it("reads the token by entity id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(LIVE_TOKEN)),
    );
    const info = await fetchTokenInfo("0x0000000000000000000000000000000000A567E4");
    expect(fetchMock().mock.calls[0][0]).toBe(`${MIRROR_URL}/api/v1/tokens/0.0.10840036`);
    expect(info.total_supply).toBe("89430152857744");
  });

  it("returns the charged fee of the scheduled run as bigint tinybar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ transactions: [{ charged_tx_fee: 140_356_237 }] })),
    );
    expect(await fetchRunFee("1791107076.082884956")).toBe(140_356_237n);
    expect(fetchMock().mock.calls[0][0]).toBe(`${MIRROR_URL}/api/v1/transactions?timestamp=1791107076.082884956`);
  });

  it("returns null when the run has no transaction yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ transactions: [] })),
    );
    expect(await fetchRunFee("1791107076.082884956")).toBeNull();
  });
});

describe("waitForContractResult", () => {
  const hash = `0x${"11".repeat(32)}` as Hex;

  it("keeps polling through 404 until the mirror node has the result", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls < 3 ? jsonResponse({}, 404) : jsonResponse({ result: "SUCCESS", call_result: "0x16" }),
      ),
    );
    const pending = waitForContractResult(hash);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ result: "SUCCESS", call_result: "0x16" });
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );
    await expect(waitForContractResult(hash)).rejects.toMatchObject({ status: 500 });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("gives up after 20 attempts with a message pointing to HashScan", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 404)),
    );
    const pending = waitForContractResult(hash);
    const assertion = expect(pending).rejects.toThrow(/HashScan/);
    await vi.advanceTimersByTimeAsync(20 * 1_500);
    await assertion;
    expect(fetchMock()).toHaveBeenCalledTimes(20);
  });
});
