import { ENGINE_ABI } from "./constants";
import { explainError, revertName } from "./errors";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";

const reverted = (errorName: string, args: unknown[] = []) => {
  const data = encodeErrorResult({ abi: ENGINE_ABI, errorName, args } as never);
  const inner = new ContractFunctionRevertedError({ abi: ENGINE_ABI, data, functionName: "buyback" });
  return new ContractFunctionExecutionError(inner, { abi: ENGINE_ABI, functionName: "buyback" });
};

describe("revertName", () => {
  it("finds the custom error name inside a wrapped viem error", () => {
    expect(revertName(reverted("StaleOracle", [1n]))).toBe("StaleOracle");
    expect(revertName(reverted("NothingBought"))).toBe("NothingBought");
  });

  it("is undefined for anything that is not a decoded revert", () => {
    expect(revertName(new Error("boom"))).toBeUndefined();
    expect(revertName(undefined)).toBeUndefined();
    expect(revertName("StaleOracle")).toBeUndefined();
  });
});

describe("explainError", () => {
  it("explains a named revert in the page's words", () => {
    expect(explainError(reverted("StaleOracle", [1n]))).toBe(
      "Chainlink HBAR/USD is older than the engine allows. Buybacks wait for the next update.",
    );
    expect(explainError(reverted("AllocationBreach"))).toMatch(/pool or team allocation/);
  });

  it("has a bespoke explanation for every error the engine declares that a user can hit", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../foundry/contracts/FurnaceEngine.sol"), "utf8");
    const declared = [...source.matchAll(/^\s*error (\w+)\(/gm)].map(m => m[1]);
    const abiErrors = ENGINE_ABI.filter(i => i.type === "error");
    expect(declared.length).toBeGreaterThan(15);
    // OnlySelf guards the scheduled self-call, which a wallet cannot trigger.
    for (const name of declared.filter(n => n !== "OnlySelf")) {
      const item = abiErrors.find(e => e.name === name);
      expect(item, `${name} is in the ABI`).toBeDefined();
      const args = item!.inputs.map(input =>
        input.type === "address" ? "0x0000000000000000000000000000000000000001" : 1,
      );
      expect(explainError(reverted(name, args)), name).not.toMatch(/^The engine reverted with/);
    }
  });

  it("falls back to naming an error it has no sentence for", () => {
    expect(explainError(reverted("OnlySelf"))).toBe("The engine reverted with OnlySelf.");
  });

  it("recognises a wallet rejection by code and by message", () => {
    expect(explainError(Object.assign(new Error("whatever"), { code: 4001 }))).toBe("Rejected in the wallet.");
    expect(explainError(new Error("User rejected the request."))).toBe("Rejected in the wallet.");
    expect(explainError(new Error("MetaMask Tx Signature: User denied transaction signature."))).toBe(
      "Rejected in the wallet.",
    );
  });

  it("passes through other messages and never returns an empty string", () => {
    expect(explainError(new Error("insufficient funds for gas"))).toBe("insufficient funds for gas");
    expect(explainError(new Error(""))).toBe("The transaction failed.");
    expect(explainError(undefined)).toBe("The transaction failed.");
    expect(explainError({ weird: true })).toBe("The transaction failed.");
  });
});
