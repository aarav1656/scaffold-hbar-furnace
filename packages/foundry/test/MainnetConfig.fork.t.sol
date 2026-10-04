// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";

/// The README's "Deploy to mainnet" table, deployed against a Hedera mainnet fork. The constructor resolves the
/// SaucerSwap V1 factory and WHBAR from the router and wires the Chainlink feed, so a wrong row reverts here or
/// reads back wrong. Run:
/// `forge test --match-path test/MainnetConfig.fork.t.sol --fork-url https://mainnet.hashio.io/api`
contract MainnetConfigForkTest is Test {
    address constant ROUTER = 0x00000000000000000000000000000000002E7A5D; // SaucerSwap V1 RouterV3
    address constant FACTORY = 0x0000000000000000000000000000000000103780; // SaucerSwap V1 FactoryV1
    address constant WHBAR = 0x0000000000000000000000000000000000163B5a; // WHBAR HTS token
    address constant HBAR_USD = 0xAF685FB45C12b92b5054ccb9313e135525F9b5d5; // Chainlink HBAR/USD, 8 decimals

    function setUp() public {
        if (block.chainid != 295) vm.skip(true);
    }

    function test_mainnetTable_deploysAndResolvesTheEngine() public {
        FurnaceEngine engine = new FurnaceEngine(
            FurnaceEngine.Config({
                router: ROUTER,
                hbarUsdFeed: HBAR_USD,
                maxOracleAge: 1 days + 1 hours,
                fuelReserve: 25 * 1e8,
                minSpend: 1e8,
                scheduledGas: 4_000_000,
                dailyBudgetUsd: 1e8,
                maxImpactBps: 500,
                priceCeilingUsd: 0,
                slippageBps: 300
            })
        );

        assertEq(address(engine.factory()), FACTORY, "mainnet router resolves the SaucerSwap V1 factory");
        assertEq(engine.whbar(), WHBAR, "mainnet router resolves the WHBAR HTS token");

        // hbarUsd() reverts on a stale or non-positive answer, so this also proves the feed is fresh at the fork block.
        uint256 oracle = engine.hbarUsd();
        emit log_named_uint("Chainlink HBAR/USD e8", oracle);
        assertGt(oracle, 0, "mainnet HBAR/USD answer is positive at the fork block");
    }
}
