import { formatUnits, parseUnits } from "viem";

/** JSON-RPC counts HBAR in weibar (18 decimals); the EVM inside Hedera counts tinybar (8). */
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

const DECIMAL = /^\d+(\.\d{1,8})?$/;

/** A decimal string with at most 8 places as its integer unit (tinybar, or USD x 1e8). Zero is allowed only when `allowZero`. */
export function parseAmount(text: string, label = "amount", allowZero = false): bigint {
  const t = text.trim();
  if (!DECIMAL.test(t)) throw new Error(`${label} must be a plain decimal with at most 8 decimals, got "${text}"`);
  const value = parseUnits(t, 8);
  if (value === 0n && !allowZero) throw new Error(`${label} must be above zero`);
  return value;
}

export const fmt8 = (value: bigint) => formatUnits(value, 8);
export const fmtUnits = (value: bigint, decimals: number) => formatUnits(value, decimals);
