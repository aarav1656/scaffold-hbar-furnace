import { z } from "zod";
import { POLICY_NAMES } from "./analysis";

/** A decimal with at most 8 places, given as a string or a number (models send either). Zero is refused. */
const decimal8 = (what: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 }) : v.trim()))
    .pipe(
      z
        .string()
        .regex(/^\d+(\.\d{1,8})?$/, `${what} must be a plain decimal with at most 8 places, for example "1.5"`)
        .refine((v) => /[1-9]/.test(v), `${what} must be above zero`),
    );

const account = z
  .string()
  .regex(/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/, "account must be 0.0.N or a 0x EVM address")
  .describe("Hedera account id (0.0.N) or EVM address");

export const getFurnaceStateSchema = z.object({});

export const previewBuybackSchema = z.object({});

export const sendRevenueSchema = z.object({
  hbar: decimal8("hbar").describe('HBAR of revenue to send to the engine, as a decimal string, for example "1.5"'),
  source: z
    .string()
    .regex(/^[\x20-\x7e]{1,32}$/, "source is 1 to 32 printable ASCII characters")
    .optional()
    .describe('Optional label for where the revenue came from, for example "swap-fees". Recorded on chain with the amount (RevenueTagged); without it the HBAR arrives as plain revenue.'),
});

export const buybackNowSchema = z.object({
  force: z.boolean().default(false).describe("Send the buyback even when the engine would skip it. A skipped run spends nothing, burns nothing and still costs gas."),
});

export const setPolicySchema = z.object({
  setting: z.enum(POLICY_NAMES as [string, ...string[]]).describe("Which policy parameter to change"),
  value: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 }) : v.trim()))
    .describe("New value: USD as a decimal string for dailyBudgetUsd, priceCeilingUsd and maxLotUsd (0 turns a cap off); a whole number for basis points and seconds"),
});

export const startAutomationSchema = z.object({
  intervalSeconds: z.number().int().min(60).max(5_184_000).describe("Seconds between scheduled buybacks, 60 to 5184000 (60 days)"),
});

export const stopAutomationSchema = z.object({});
export const rearmAutomationSchema = z.object({});

export type SendRevenueParams = z.infer<typeof sendRevenueSchema>;
export type SetPolicyParams = z.infer<typeof setPolicySchema>;
export { account as accountSchema };
