import { LIVE_TOKEN } from "./__fixtures__";
import { evmToEntityId, hashscan } from "./hedera";
import { describe, expect, it } from "vitest";

const pad = (shard: bigint, realm: bigint, num: bigint) =>
  `0x${shard.toString(16).padStart(8, "0")}${realm.toString(16).padStart(16, "0")}${num.toString(16).padStart(16, "0")}`;

describe("evmToEntityId", () => {
  it("reads the live FURN token address as the entity id the mirror node reports", () => {
    expect(evmToEntityId("0x0000000000000000000000000000000000A567E4")).toBe("0.0.10840036");
    expect(evmToEntityId("0x0000000000000000000000000000000000A567E4")).toBe(LIVE_TOKEN.token_id);
  });

  it("is case-insensitive on the hex digits", () => {
    expect(evmToEntityId("0x0000000000000000000000000000000000a567e4")).toBe("0.0.10840036");
  });

  it("keeps shard, realm and num in their own byte ranges", () => {
    expect(evmToEntityId(pad(1n, 2n, 3n))).toBe("1.2.3");
    expect(evmToEntityId(pad(7n, 0n, 0n))).toBe("7.0.0");
    expect(evmToEntityId(pad(0n, 9n, 0n))).toBe("0.9.0");
    expect(evmToEntityId(pad(0xdeadbeefn, (1n << 40n) + 5n, (1n << 40n) + 7n))).toBe(
      `${0xdeadbeefn}.${(1n << 40n) + 5n}.${(1n << 40n) + 7n}`,
    );
    expect(evmToEntityId(pad(0n, 0n, (1n << 64n) - 1n))).toBe(`0.0.${(1n << 64n) - 1n}`);
  });

  it("maps the zero address to 0.0.0", () => {
    expect(evmToEntityId("0x0000000000000000000000000000000000000000")).toBe("0.0.0");
  });
});

describe("hashscan links", () => {
  const token = "0x0000000000000000000000000000000000A567E4";
  const schedule = "0x0000000000000000000000000000000000A5A3bC";

  it("links tokens and schedules by entity id, not by EVM address", () => {
    expect(hashscan.token(token)).toBe("https://hashscan.io/testnet/token/0.0.10840036");
    expect(hashscan.schedule(schedule)).toBe("https://hashscan.io/testnet/schedule/0.0.10855356");
  });

  it("links transactions, contracts and accounts by the value given", () => {
    expect(hashscan.tx("0xabc")).toBe("https://hashscan.io/testnet/transaction/0xabc");
    expect(hashscan.contract("0xdef")).toBe("https://hashscan.io/testnet/contract/0xdef");
    expect(hashscan.account("0.0.5")).toBe("https://hashscan.io/testnet/account/0.0.5");
  });
});
