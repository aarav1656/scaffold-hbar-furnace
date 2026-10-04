// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// Lot size and the gap between buys: spend is spread over the day instead of landing in one block.
contract FurnacePacingTest is FurnaceBase {
    function setUp() public virtual override {
        super.setUp();
        _ready();
        _revenue(300e8);
    }

    function _expectSkip(FurnaceEngine.Skip reason) internal {
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(reason);
    }

    function _skip() internal view returns (FurnaceEngine.Skip skip) {
        (skip,) = engine.previewBuyback();
    }

    // ---------------------------------------------------------------- lot size

    function test_lot_capsOneBuyInUsd() public {
        vm.prank(owner);
        engine.setMaxLotUsd(5e8); // $5 is 25 HBAR at $0.20
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertEq(spend, 25e8, "299 HBAR of revenue, 500 HBAR of budget and a 52 HBAR impact cap: the lot binds");
        uint256 before = address(engine).balance;
        _buyback();
        assertEq(before - address(engine).balance, 25e8);
        assertEq(router.lastSwapValue(), 25e8);
    }

    function test_lot_followsTheHbarPrice() public {
        vm.prank(owner);
        engine.setMaxLotUsd(5e8);
        feed.set(40_000_000, block.timestamp); // HBAR at $0.40: $5 is 12.5 HBAR
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, 125e7);
    }

    function test_lot_zeroMeansNoCap() public view {
        assertEq(engine.maxLotUsd(), 0);
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, 5_263_157_894, "the 5% impact cap sets the size");
    }

    function test_lot_aLotBelowTheMinimumSpendSkipsAndSaysSo() public {
        vm.prank(owner);
        engine.setMaxLotUsd(1e8); // $1
        feed.set(200_000_000, block.timestamp); // HBAR at $2: $1 is 0.5 HBAR, under the 1 HBAR minimum
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.LotCap));
        _expectSkip(FurnaceEngine.Skip.LotCap);
        assertEq(_buyback(), 0);
    }

    function test_lot_theEarlierCapsAreNamedFirst() public {
        vm.startPrank(owner);
        engine.setMaxLotUsd(1e8);
        engine.setDailyBudgetUsd(0);
        vm.stopPrank();
        feed.set(200_000_000, block.timestamp);
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.BudgetSpent));
    }

    function test_lot_smallerOfLotAndBudgetWins() public {
        vm.startPrank(owner);
        engine.setMaxLotUsd(50e8);
        engine.setDailyBudgetUsd(10e8); // $10 is 50 HBAR; one $50 lot would be 250
        vm.stopPrank();
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, 50e8, "the daily budget is tighter than the lot");
        vm.prank(owner);
        engine.setDailyBudgetUsd(100e8);
        vm.prank(owner);
        engine.setMaxLotUsd(2e8);
        (, spend) = engine.previewBuyback();
        assertEq(spend, 10e8, "the lot is tighter than the budget");
    }

    function test_setMaxLot_isOwnerOnlyBoundedAndEmits() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setMaxLotUsd(5e8);

        uint256 min = engine.MIN_LOT_USD();
        assertEq(min, 1e8);
        vm.startPrank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxLotUsd(min - 1);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxLotUsd(uint256(type(uint64).max) + 1);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.MaxLotSet(min);
        engine.setMaxLotUsd(min);
        assertEq(engine.maxLotUsd(), min);
        engine.setMaxLotUsd(0);
        assertEq(engine.maxLotUsd(), 0, "zero lifts the cap");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- gap between buys

    function test_gap_isOffByDefault() public {
        assertEq(engine.minGapSeconds(), 0);
        _buyback();
        _pass(60);
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.None));
    }

    function test_gap_skipsInsideItAndBuysOnTheExactSecond() public {
        vm.prank(owner);
        engine.setMinGapSeconds(1 hours);
        assertGt(_buyback(), 0);
        assertEq(engine.lastBuyAt(), T0);

        _pass(1 hours - 1);
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.TooSoon));
        uint256 balance = address(engine).balance;
        _expectSkip(FurnaceEngine.Skip.TooSoon);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, balance, "nothing spent");
        assertEq(engine.lastBuyAt(), T0, "a skipped run does not extend the gap");

        _pass(1);
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.None), "reopens exactly gap seconds after the last spend");
        assertGt(_buyback(), 0);
        assertEq(engine.lastBuyAt(), T0 + 1 hours);
    }

    function test_gap_aRunSkippedForAnotherReasonNeverStartsIt() public {
        vm.startPrank(owner);
        engine.setMinGapSeconds(1 hours);
        engine.setDailyBudgetUsd(0);
        vm.stopPrank();
        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        _buyback();
        assertEq(engine.lastBuyAt(), 0);
        vm.prank(owner);
        engine.setDailyBudgetUsd(DAILY_BUDGET_USD);
        _pass(60);
        assertEq(uint8(_skip()), uint8(FurnaceEngine.Skip.None), "no spend, so no gap");
    }

    function test_gap_aRunInsideItLeavesThePriceSnapshotAlone() public {
        vm.prank(owner);
        engine.setMinGapSeconds(1 hours);
        _buyback();
        uint256 at = engine.twapAt();
        uint256 cumulative = engine.twapCumulative();
        _pass(10 minutes);
        _expectSkip(FurnaceEngine.Skip.TooSoon);
        _buyback();
        assertEq(engine.twapAt(), at);
        assertEq(engine.twapCumulative(), cumulative);
    }

    function test_gap_isCheckedBeforeTheOracleIsRead() public {
        vm.prank(owner);
        engine.setMinGapSeconds(1 hours);
        _buyback();
        _pass(10);
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1); // stale
        _expectSkip(FurnaceEngine.Skip.TooSoon);
        assertEq(_buyback(), 0);
    }

    function test_gap_theOwnerCannotBypassItWithAManualBuyback() public {
        vm.prank(owner);
        engine.setMinGapSeconds(1 hours);
        _buyback();
        _pass(2 minutes);
        _expectSkip(FurnaceEngine.Skip.TooSoon);
        assertEq(_buyback(), 0);
    }

    function test_gap_scheduledRunInsideItNeitherRevertsNorStopsBooking() public {
        vm.startPrank(owner);
        engine.setMinGapSeconds(1 days); // one buy a day on a 1 hour schedule
        engine.startAutomation(1 hours);
        vm.stopPrank();

        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        assertGt(engine.totalBurned(), 0, "the first run buys");
        uint256 burned = engine.totalBurned();

        vm.recordLogs();
        (ok,) = _runSchedule(1, true);
        assertTrue(ok, "a run inside the gap must not fail the scheduled transaction");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1, "the chain continues");
        assertEq(hss.callCount(), 3);
        assertEq(engine.totalBurned(), burned);
        assertEq(engine.runInterval(), 1 hours);
    }

    function test_setMinGap_isOwnerOnlyBoundedAndEmits() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setMinGapSeconds(60);

        uint256 max = engine.MAX_MIN_GAP();
        assertEq(max, 1 days);
        vm.startPrank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMinGapSeconds(max + 1);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.MinGapSet(max);
        engine.setMinGapSeconds(max);
        assertEq(engine.minGapSeconds(), max);
        engine.setMinGapSeconds(0);
        assertEq(engine.minGapSeconds(), 0);
        vm.stopPrank();
    }

    function test_statusCarriesTheLastSpendAndTheNextEligibleSecond() public {
        vm.prank(owner);
        engine.setMinGapSeconds(1 hours);
        assertEq(engine.status().nextBuyAt, 0, "nothing has spent yet");
        _buyback();
        FurnaceEngine.Status memory s = engine.status();
        assertEq(s.lastBuyAt, T0);
        assertEq(s.nextBuyAt, T0 + 1 hours);
        _pass(1 hours);
        assertEq(engine.status().nextBuyAt, 0, "open now");
    }

    // ---------------------------------------------------------------- construction

    function test_constructor_refusesPacingOutsideTheBounds() public {
        FurnaceEngine.Config memory c = _config();
        c.maxLotUsd = 1e8 - 1;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.minGapSeconds = 1 days + 1;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.maxLotUsd = 5e8;
        c.minGapSeconds = 15 minutes;
        FurnaceEngine e = new FurnaceEngine(c);
        assertEq(e.maxLotUsd(), 5e8);
        assertEq(e.minGapSeconds(), 15 minutes);
    }
}

/// The same suite with WHBAR sorting above the token.
contract FurnacePacingReversedOrderTest is FurnacePacingTest {
    function whbarAddr() internal pure override returns (address) {
        return address(type(uint160).max);
    }
}
