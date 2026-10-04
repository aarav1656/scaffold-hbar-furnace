import { type Address, parseAbi, zeroAddress } from "viem";
import { hederaTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";

export const CHAIN_ID = hederaTestnet.id;

const deployed = deployedContracts[CHAIN_ID].FurnaceEngine;
export const ENGINE_ABI = deployed.abi;
export const ENGINE_ADDRESS = deployed.address as Address;
export const IS_DEPLOYED = ENGINE_ADDRESS.toLowerCase() !== zeroAddress;

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

/** IHRC719: every HTS token answers `associate()` at its own address, for msg.sender. Returns an HTS response code. */
export const HRC719_ABI = parseAbi(["function associate() returns (int64)"]);

export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** HTS response codes the associate step accepts. */
export const HTS_SUCCESS = 22n;
export const HTS_ALREADY_ASSOCIATED = 194n;

export const USD_DECIMALS = 8;
/** Contract-side HBAR is tinybars (8 decimals); the JSON-RPC layer counts weibars (18 decimals). */
export const TINYBAR_DECIMALS = 8;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** The engine's `Skip` enum, in declaration order. */
export const SKIP_REASONS = ["None", "NotReady", "NoFunds", "BudgetSpent", "PriceCeiling", "ImpactCap"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Why a run spent nothing, in the words the page uses for both the dry run and the BuybackSkipped log. */
export const SKIP_TEXT: Record<SkipReason, string> = {
  None: "It would spend.",
  NotReady: "The pool has no liquidity yet.",
  NoFunds: "Revenue above the fuel reserve is below the minimum buyback.",
  BudgetSpent: "Today's USD budget is spent.",
  PriceCeiling: "The token price is at the USD ceiling.",
  ImpactCap: "The pool is too shallow for the price-impact cap.",
};

/**
 * Gas floors per call. hashio's estimates undershoot HTS-heavy calls, so a final limit is max(1.25 x estimate, floor).
 * Hedera bills gas used but checks the payer's balance against the whole limit. Measured on testnet in brackets.
 */
export const GAS_FLOOR = {
  associate: 1_000_000n,
  buyback: 1_500_000n, // manual burn 361,563
  startAutomation: 3_000_000n, // 1,509,024
  stopAutomation: 500_000n, // 99,514, including deleteSchedule
  setPolicy: 300_000n,
  claimTeamAllocation: 500_000n, // 51,231
  initialize: 1_500_000n, // 232,992
  createPool: 10_000_000n, // 6,622,028: the pair associates its tokens inside the call
  seedLiquidity: 3_000_000n, // 993,009
  revenue: 150_000n, // plain transfer into receive(), 22,491
} as const;
export const GAS_CAP = 14_000_000n;

export const POLL_MS = 15_000;
