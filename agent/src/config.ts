import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

export type EngineConfig = {
  engine: Address;
  /** Function names the deployed ABI carries, or null when the address came from the environment (assume the current engine). */
  abiFunctions: ReadonlySet<string> | null;
  rpcUrl: string;
  mirrorUrl: string;
  hashscanUrl: string;
};

const DEFAULT_DEPLOYED = fileURLToPath(new URL("../../packages/nextjs/contracts/deployedContracts.ts", import.meta.url));
const pick = (value: string | undefined, fallback: string) => (value && value.trim() !== "" ? value.trim() : fallback);

/**
 * The canonical FurnaceEngine on Hedera testnet (chain 296) as the scaffold's generated deployedContracts.ts
 * declares it, with the function names of its ABI. Nothing is hardcoded: a redeploy rewrites that file and
 * this reads the new address on the next start.
 */
export function parseDeployed(text: string): { engine: Address; functions: Set<string> } {
  const at = text.search(/\b296:\s*\{/);
  const scope = at < 0 ? "" : text.slice(at);
  const match = /FurnaceEngine:\s*\{\s*address:\s*"(0x[0-9a-fA-F]{40})"/.exec(scope);
  if (!match) throw new Error("deployedContracts.ts has no FurnaceEngine entry for chain 296 (Hedera testnet).");
  const end = scope.indexOf("inheritedFunctions", match.index);
  const abi = scope.slice(match.index, end < 0 ? undefined : end);
  const functions = new Set([...abi.matchAll(/type:\s*"function",\s*name:\s*"(\w+)"/g)].map((m) => m[1]!));
  if (functions.size === 0) throw new Error("deployedContracts.ts lists no functions for FurnaceEngine.");
  return { engine: match[1] as Address, functions };
}

/** Environment: FURNACE_ENGINE (wins), FURNACE_DEPLOYED_CONTRACTS (path), HEDERA_RPC_URL, HEDERA_MIRROR_URL. */
export function configFromEnv(env: Record<string, string | undefined> = process.env, read: (path: string) => string = (p) => readFileSync(p, "utf8")): EngineConfig {
  let engine = env.FURNACE_ENGINE?.trim() as Address | undefined;
  let abiFunctions: Set<string> | null = null;
  if (engine) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(engine)) throw new Error(`FURNACE_ENGINE is not an EVM address: ${engine}`);
  } else {
    const path = pick(env.FURNACE_DEPLOYED_CONTRACTS, DEFAULT_DEPLOYED);
    let text: string;
    try {
      text = read(path);
    } catch {
      throw new Error(`Cannot read ${path}. Set FURNACE_ENGINE=0x... to point the plugin at an engine without the scaffold checked out.`);
    }
    ({ engine, functions: abiFunctions } = parseDeployed(text));
  }
  return {
    engine,
    abiFunctions,
    rpcUrl: pick(env.HEDERA_RPC_URL, "https://testnet.hashio.io/api"),
    mirrorUrl: pick(env.HEDERA_MIRROR_URL, "https://testnet.mirrornode.hedera.com").replace(/\/$/, ""),
    hashscanUrl: "https://hashscan.io/testnet",
  };
}

/** Whether the engine in `cfg` has `fn`. An engine given by address alone is the current engine, which has every function. */
export const hasFunction = (cfg: EngineConfig, fn: string) => cfg.abiFunctions === null || cfg.abiFunctions.has(fn);
