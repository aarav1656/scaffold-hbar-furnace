//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";

/// @notice Deploys a FurnaceEngine wired to SaucerSwap V1 and the Chainlink HBAR/USD feed on Hedera testnet.
/// @dev Addresses are Hedera testnet; swap them for mainnet. Policy comes from the environment, with these defaults:
///   DAILY_BUDGET_USD   USD the engine may spend per 24h, 8 decimals     (default 1e8, $1.00)
///   MAX_IMPACT_BPS     price impact one buyback may cause, <= 1000      (default 500, 5%)
///   PRICE_CEILING_USD  USD per whole token, 8 decimals, 0 for none      (default 0)
///   SLIPPAGE_BPS       tolerance below the router quote, <= 1000        (default 300)
///   FUEL_RESERVE_HBAR  whole HBAR that buybacks never touch             (default 25)
///   MIN_SPEND_HBAR_E8  smallest buyback in tinybar                      (default 1e8, 1 HBAR)
contract DeployScript is ScaffoldETHDeploy {
    error UnsupportedChain(uint256 chainId);

    function run() external ScaffoldEthDeployerRunner {
        if (block.chainid != 296) revert UnsupportedChain(block.chainid);

        FurnaceEngine engine = new FurnaceEngine(
            FurnaceEngine.Config({
                router: 0x0000000000000000000000000000000000004b40, // SaucerSwap V1 RouterV3 0.0.19264
                hbarUsdFeed: 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a, // Chainlink HBAR/USD, 8 decimals
                maxOracleAge: 1 days + 1 hours,
                fuelReserve: vm.envOr("FUEL_RESERVE_HBAR", uint256(25)) * 1e8,
                minSpend: vm.envOr("MIN_SPEND_HBAR_E8", uint256(1e8)),
                scheduledGas: 4_000_000,
                dailyBudgetUsd: vm.envOr("DAILY_BUDGET_USD", uint256(1e8)),
                maxImpactBps: vm.envOr("MAX_IMPACT_BPS", uint256(500)),
                priceCeilingUsd: vm.envOr("PRICE_CEILING_USD", uint256(0)),
                slippageBps: vm.envOr("SLIPPAGE_BPS", uint256(300))
            })
        );
        deployments.push(Deployment({ name: "FurnaceEngine", addr: address(engine) }));
    }
}
