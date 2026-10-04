// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// Who may trigger a buy, who may re-book a dead schedule, where revenue came from, and the swap floor that does not
/// trust the router's own quote.
contract FurnaceAccessTest is FurnaceBase {
    uint256 internal constant INTERVAL = 1 hours;
    int64 internal constant SCHEDULE_BUSY = 370;

    function setUp() public virtual override {
        super.setUp();
        _ready();
        _revenue(300e8);
    }

    function _open(uint256 gap) internal {
        vm.prank(owner);
        engine.setMinGapSeconds(gap);
    }

    function _callAs(address who) internal returns (uint256 burned) {
        vm.prank(who);
        burned = engine.buyback();
    }

    // ---------------------------------------------------------------- anyone may buy once a gap is set

    function test_withoutAGapOnlyTheOwnerOrTheEngineMayBuy() public {
        vm.prank(keeper);
        vm.expectRevert(FurnaceEngine.NotOwnerOrSelf.selector);
        engine.buyback();
        assertGt(_callAs(owner), 0);
        _pass(MIN_WINDOW);
        assertGt(_callAs(address(engine)), 0);
    }

    function test_withAGapAnyoneMayTriggerABuy() public {
        _open(1 hours);
        uint256 supply = furn.totalSupply();
        uint256 burned = _callAs(keeper);
        assertGt(burned, 0);
        assertEq(supply - furn.totalSupply(), burned, "a keeper's buy burns what it bought, like any other");
        assertEq(engine.lastBuyAt(), T0);
        assertEq(owner.balance, 0);
        assertEq(keeper.balance, 0, "and the keeper is paid nothing");
    }

    function test_anOutsiderInsideTheGapIsRefusedAndChangesNothing() public {
        _open(1 hours);
        _callAs(keeper);
        uint256 at = engine.twapAt();
        uint256 cumulative = engine.twapCumulative();
        uint256 balance = address(engine).balance;
        _pass(30 minutes);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BuybackRefused.selector, FurnaceEngine.Skip.TooSoon));
        engine.buyback();
        assertEq(engine.twapAt(), at, "an outsider cannot restart the average");
        assertEq(engine.twapCumulative(), cumulative);
        assertEq(address(engine).balance, balance);
    }

    function test_anOutsiderCannotMoveTheSnapshotWithARefusedCall() public {
        _open(1 hours);
        _pass(MIN_WINDOW);
        _pump(40e8);
        uint256 at = engine.twapAt();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BuybackRefused.selector, FurnaceEngine.Skip.TwapDeviation));
        engine.buyback();
        assertEq(engine.twapAt(), at, "so a pump followed by a keeper call does not reset the window");

        // The owner's own call still records the skip and moves the snapshot.
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.TwapDeviation);
        _callAs(owner);
        assertEq(engine.twapAt(), block.timestamp);
    }

    function test_anOutsiderThatWouldSpendNothingIsRefusedWithTheReason() public {
        _open(1 hours);
        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BuybackRefused.selector, FurnaceEngine.Skip.BudgetSpent));
        engine.buyback();
    }

    function test_theOwnerInsideTheGapStillGetsASkipRecord() public {
        _open(1 hours);
        _callAs(keeper);
        _pass(10 minutes);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.TooSoon);
        assertEq(_callAs(owner), 0);
    }

    function test_theGapBindsEveryCallerTheSame() public {
        _open(1 hours);
        _callAs(owner);
        _pass(1 hours - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BuybackRefused.selector, FurnaceEngine.Skip.TooSoon));
        engine.buyback();
        _pass(1);
        assertGt(_callAs(keeper), 0, "reopens on the exact second for an outsider too");
    }

    function test_aPublicBuyKeepsTheLotTheBudgetAndTheBurnRules() public {
        _open(1 hours);
        vm.prank(owner);
        engine.setMaxLotUsd(5e8);
        _callAs(keeper);
        assertEq(router.lastSwapValue(), 25e8, "the lot cap binds a keeper's buy");
        assertEq(furn.totalSupply(), TOTAL_SUPPLY - engine.totalBurned());
        assertGe(furn.balanceOf(address(engine)), engine.teamUnclaimed() + engine.liquidityUnseeded());
        assertGe(address(engine).balance, FUEL);
    }

    // ---------------------------------------------------------------- rearm

    function _start() internal {
        vm.prank(owner);
        engine.startAutomation(INTERVAL);
    }

    function test_rearm_needsAutomationOn() public {
        vm.expectRevert(FurnaceEngine.AutomationOff.selector);
        engine.rearm();
    }

    function test_rearm_leavesALiveScheduleAlone() public {
        _start();
        uint256 calls = hss.callCount();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.ScheduleLive.selector, engine.nextRunAt()));
        engine.rearm();
        vm.warp(engine.nextRunAt() + engine.REARM_GRACE());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.ScheduleLive.selector, engine.nextRunAt()));
        engine.rearm();
        assertEq(hss.callCount(), calls, "no second chain");
    }

    function test_rearm_booksAReplacementOnceTheScheduleIsOverdue() public {
        _start();
        address stale = engine.pendingSchedule();
        uint256 expiry = engine.nextRunAt();
        vm.warp(expiry + engine.REARM_GRACE() + 1);
        feed.set(HBAR_USD, block.timestamp);

        vm.recordLogs();
        vm.prank(keeper);
        engine.rearm();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.Rearmed.selector), 1);
        assertEq(hss.callCount(), 2);
        assertEq(hss.deleteCount(), 1, "the dead schedule is deleted if it still exists");
        assertTrue(engine.pendingSchedule() != stale && engine.pendingSchedule() != address(0));
        assertEq(engine.nextRunAt(), block.timestamp + INTERVAL);
        assertEq(engine.runInterval(), INTERVAL);

        (bool ok,) = _runSchedule(1, true);
        assertTrue(ok);
        assertGt(engine.totalBurned(), 0, "the revived chain buys");
        assertEq(hss.callCount(), 3, "and keeps booking");
    }

    function test_rearm_revertsWhenTheNetworkRefusesTheBooking() public {
        _start();
        vm.warp(engine.nextRunAt() + engine.REARM_GRACE() + 1);
        hss.setForcedCodes(SCHEDULE_BUSY, 0);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.ScheduleFailed.selector, SCHEDULE_BUSY));
        engine.rearm();
        assertEq(engine.runInterval(), INTERVAL, "automation stays on so the next caller can retry");
    }

    // ---------------------------------------------------------------- revenue by source

    function test_depositRevenue_tagsTheSourceAndKeepsTheHbar() public {
        bytes32 source = bytes32("swap-fees");
        vm.deal(alice, 7e8);
        uint256 before = address(engine).balance;
        vm.expectEmit(address(engine));
        emit FurnaceEngine.RevenueTagged(source, alice, 7e8);
        vm.prank(alice);
        engine.depositRevenue{ value: 7e8 }(source);
        assertEq(address(engine).balance, before + 7e8, "tagged HBAR is revenue like any other");
    }

    function test_depositRevenue_refusesZeroAndPlainTransfersStayUntagged() public {
        vm.expectRevert(FurnaceEngine.ZeroAmount.selector);
        engine.depositRevenue(bytes32("x"));

        vm.recordLogs();
        _revenue(1e8);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.RevenueReceived.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.RevenueTagged.selector), 0, "a plain transfer is the untagged stream");
    }

    // ---------------------------------------------------------------- the floor that does not trust the quote

    function test_aRouterThatQuotesAndFillsABadPriceIsStoppedByTheAveragePriceFloor() public {
        router.setPriceSkewBps(2000); // quote and fill both 20% under the pool's price
        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_OUTPUT_AMOUNT");
        engine.buyback();
        assertEq(engine.totalBurned(), 0);
        assertEq(router.swapCount(), 0);
    }

    function test_aRouterWithinTheAllowanceStillFills() public {
        router.setPriceSkewBps(300);
        assertGt(_callAs(owner), 0, "the floor is loose enough that an honest fill never trips it");
    }

    function test_theFloorIsLooserThanAnHonestFillAtEveryCap() public {
        // The largest spend the impact cap allows, with spot at the top of the allowed distance above the average.
        vm.prank(owner);
        engine.setMaxImpactBps(1000);
        _moveReserves(1049e8, LIQUIDITY); // +4.9% against the 5% bound
        assertGt(_callAs(owner), 0, "a fair fill at the extreme of every cap clears the floor");
    }
}

/// The same suite with WHBAR sorting above the token.
contract FurnaceAccessReversedOrderTest is FurnaceAccessTest {
    function whbarAddr() internal pure override returns (address) {
        return address(type(uint160).max);
    }
}
