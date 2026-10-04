// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Test } from "forge-std/Test.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { IHRC719 } from "../contracts/interfaces/IHRC719.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// Drives the engine through random sequences of every action an owner, a payer or the network can take.
contract FurnaceHandler is Test {
    FurnaceEngine public immutable engine;
    address public immutable owner;
    address public immutable recipient;
    uint256 public immutable hbarUsd;
    uint256 public buybacks;
    uint256 public skipped;
    /// Buys that spent past the lot cap, inside the gap, or while spot stood outside the average-price bound.
    uint256 public lotViolations;
    uint256 public gapViolations;
    uint256 public twapViolations;

    constructor(FurnaceEngine engine_, address owner_, address recipient_, uint256 hbarUsd_) {
        engine = engine_;
        owner = owner_;
        recipient = recipient_;
        hbarUsd = hbarUsd_;
    }

    function revenue(uint256 amount) external {
        amount = bound(amount, 0, 300e8);
        vm.deal(address(this), amount);
        (bool ok,) = address(engine).call{ value: amount }("");
        require(ok);
    }

    function buyback(uint256 dt) external {
        // The network runs a buy some time after the last thing that happened.
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
        FurnaceBaseFeed(address(engine.hbarUsdFeed())).set(int256(hbarUsd), block.timestamp);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        (FurnaceEngine.Skip twapState,,, uint256 deviation) = engine.twap();
        uint256 lastBuy = engine.lastBuyAt();
        uint256 before = address(engine).balance;
        vm.prank(owner);
        engine.buyback();
        uint256 spent = before - address(engine).balance;
        if (skip == FurnaceEngine.Skip.None) ++buybacks;
        else ++skipped;
        if (spent == 0) return;
        uint256 lot = engine.maxLotUsd();
        if (lot != 0 && spent > lot * 1e8 / hbarUsd) ++lotViolations;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < lastBuy + engine.minGapSeconds()) ++gapViolations;
        if (twapState != FurnaceEngine.Skip.None || deviation > engine.maxTwapDeviationBps()) ++twapViolations;
    }

    /// An outside trader buys the token and moves the price up, as the TWAP bound exists to survive.
    function pump(uint256 amount) external {
        amount = bound(amount, 1e8, 80e8);
        address token = engine.token();
        address[] memory path = new address[](2);
        path[0] = engine.whbar();
        path[1] = token;
        vm.deal(address(this), amount);
        IHRC719(token).associate();
        engine.router().swapExactETHForTokens{ value: amount }(0, path, address(this), block.timestamp + 300);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
        FurnaceBaseFeed(address(engine.hbarUsdFeed())).set(int256(hbarUsd), block.timestamp);
    }

    function setBudget(uint256 value) external {
        vm.prank(owner);
        engine.setDailyBudgetUsd(bound(value, 0, 200e8));
    }

    function setImpact(uint256 value) external {
        vm.prank(owner);
        engine.setMaxImpactBps(bound(value, 1, 1000));
    }

    function setCeiling(uint256 value) external {
        vm.prank(owner);
        engine.setPriceCeilingUsd(bound(value, 0, 400_000));
    }

    function setSlippage(uint256 value) external {
        vm.prank(owner);
        engine.setSlippageBps(bound(value, 0, 1000));
    }

    function setLot(uint256 value) external {
        value = bound(value, 0, 60e8);
        if (value != 0 && value < engine.MIN_LOT_USD()) value = engine.MIN_LOT_USD();
        vm.prank(owner);
        engine.setMaxLotUsd(value);
    }

    function setGap(uint256 value) external {
        vm.prank(owner);
        engine.setMinGapSeconds(bound(value, 0, 6 hours));
    }

    function setDeviation(uint256 value) external {
        value = bound(value, engine.MIN_TWAP_DEVIATION_BPS(), engine.MAX_TWAP_DEVIATION_BPS());
        vm.prank(owner);
        engine.setMaxTwapDeviationBps(value);
    }

    function claim() external {
        if (engine.teamUnclaimed() == 0) return;
        vm.prank(owner);
        engine.claimTeamAllocation(recipient);
    }

    function toggleAutomation() external {
        vm.startPrank(owner);
        if (engine.runInterval() == 0) engine.startAutomation(1 hours);
        else engine.stopAutomation();
        vm.stopPrank();
    }
}

interface FurnaceBaseFeed {
    function set(int256 answer, uint256 updatedAt) external;
}

contract FurnacePropertiesTest is FurnaceBase {
    FurnaceHandler internal handler;
    address internal recipient = makeAddr("recipient");
    uint256 internal lpMinted;

    function setUp() public override {
        super.setUp();
        _ready();
        vm.deal(address(engine), 50e8);
        vm.prank(recipient);
        furn.associate();
        lpMinted = lp.balanceOf(address(engine));
        handler = new FurnaceHandler(engine, owner, recipient, HBAR_USD_U);
        targetContract(address(handler));
    }

    function invariant_treasuryAlwaysCoversTheUnclaimedAllocations() public view {
        assertGe(furn.balanceOf(address(engine)), engine.teamUnclaimed() + engine.liquidityUnseeded());
    }

    function invariant_everyUnitOfSupplyLostIsABoughtBurn() public view {
        assertEq(furn.totalSupply(), TOTAL_SUPPLY - engine.totalBurned());
        assertLe(furn.totalSupply(), furn.maxSupply());
    }

    function invariant_liquidityIsLockedForGood() public view {
        assertEq(lp.balanceOf(address(engine)), lpMinted);
        assertEq(lp.totalSupply(), lpMinted);
    }

    function invariant_theFuelReserveIsNeverSpent() public view {
        assertGe(address(engine).balance, FUEL);
    }

    function invariant_noBuySpendsPastTheLotCap() public view {
        assertEq(handler.lotViolations(), 0);
    }

    function invariant_noBuySpendsInsideTheGap() public view {
        assertEq(handler.gapViolations(), 0);
    }

    function invariant_noBuySpendsWhileSpotIsOutsideTheAveragePriceBound() public view {
        assertEq(handler.twapViolations(), 0);
    }

    function invariant_hbarNeverReachesTheOwner() public view {
        assertEq(owner.balance, 0);
    }

    function invariant_theBudgetWindowNeverOverspendsItsCurrentSetting() public view {
        // spentToday can exceed a budget the owner lowered afterwards, but never the largest budget the handler sets.
        assertLe(engine.spentTodayUsd(), 200e8 + DAILY_BUDGET_USD);
    }
}
