// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// The independent price bound: the engine keeps its own cumulative-price snapshot of the V1 pair and refuses to buy
/// when spot sits more than `maxTwapDeviationBps` above the time-weighted price since that snapshot.
contract FurnaceTwapTest is FurnaceBase {
    function setUp() public virtual override {
        super.setUp();
        _ready();
        _revenue(300e8);
    }

    function _expectSkip(FurnaceEngine.Skip reason) internal {
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(reason);
    }

    function _preview() internal view returns (FurnaceEngine.Skip skip, uint256 spend) {
        return engine.previewBuyback();
    }

    // ---------------------------------------------------------------- the snapshot

    function test_seedingTheEngineStartsTheSnapshot() public view {
        assertEq(engine.twapAt(), T0 - POOL_AGE, "taken when the engine seeded the pool");
    }

    function test_aBuybackMovesTheSnapshotToItsOwnSecond() public {
        _buyback();
        assertEq(engine.twapAt(), T0);
        assertGt(engine.totalBurned(), 0);
    }

    function test_aRunThatSkipsForAnotherReasonStillMovesTheSnapshot() public {
        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        _buyback();
        assertEq(engine.twapAt(), T0, "the next window starts at this run, not at the seed");
    }

    function test_aRunInsideTheMinimumWindowLeavesTheSnapshotAlone() public {
        _buyback();
        uint256 cumulative = engine.twapCumulative();
        _pass(MIN_WINDOW - 1);
        _expectSkip(FurnaceEngine.Skip.TwapWindow);
        _buyback();
        assertEq(engine.twapAt(), T0, "a skip inside the window must not restart the clock");
        assertEq(engine.twapCumulative(), cumulative);
    }

    // ---------------------------------------------------------------- too-short windows

    function test_windowOneSecondShortOfTheMinimumSkips() public {
        _buyback();
        _pass(MIN_WINDOW - 1);
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapWindow));
        uint256 balance = address(engine).balance;
        _expectSkip(FurnaceEngine.Skip.TwapWindow);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, balance, "nothing spent");
    }

    function test_windowAtTheMinimumBuys() public {
        _buyback();
        _pass(MIN_WINDOW);
        (FurnaceEngine.Skip skip, uint256 spend) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertGt(spend, 0);
        assertGt(_buyback(), 0);
    }

    function test_theEnginesOwnPriceImpactDoesNotTripTheNextRun() public {
        _buyback();
        (uint256 h,) = _reserves();
        _pass(MIN_WINDOW);
        (uint256 priceHbar,, uint256 deviation) = _twapNow();
        assertGt(priceHbar, 0);
        assertEq(deviation, 0, "the post-buy price held for the whole window, so spot equals the average");
        assertGt(_buyback(), 0);
        (uint256 h2,) = _reserves();
        assertGt(h2, h, "the second run bought into the same pool");
    }

    function _twapNow() internal view returns (uint256 priceHbar, uint256 window, uint256 deviation) {
        FurnaceEngine.Skip state;
        (state, priceHbar, window, deviation) = engine.twap();
        assertEq(uint8(state), uint8(FurnaceEngine.Skip.None));
    }

    // ---------------------------------------------------------------- no snapshot

    function test_aPoolSeededOutsideTheEngineHasNoSnapshotAndTheFirstRunOnlyRecordsOne() public {
        // A fresh engine whose pair was funded by someone else: reserves exist, the engine never saw them.
        FurnaceEngine e = _deployEngine(_config());
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        e.initialize{ value: INIT_VALUE }("Other", "OTH", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY));
        uint256 fee = e.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        e.createPool{ value: fee }();
        address tkn = e.token();
        vm.startPrank(owner);
        MockHtsLike(tkn).associate();
        MockHtsLike(e.lpToken()).associate();
        e.claimTeamAllocation(owner);
        MockHtsLike(tkn).approve(address(router), LIQUIDITY);
        vm.deal(owner, SEED_HBAR);
        router.addLiquidityETH{ value: SEED_HBAR }(tkn, LIQUIDITY, 0, 0, owner, block.timestamp + 300);
        vm.stopPrank();
        vm.deal(address(e), 100e8);
        // The pair has been priced for an hour, so its cumulative is not zero: only the missing snapshot is at fault.
        vm.warp(block.timestamp + 1 hours);
        feed.set(HBAR_USD, block.timestamp);

        assertEq(e.twapAt(), 0, "no snapshot yet");
        (FurnaceEngine.Skip skip,) = e.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.NoTwap));
        uint256 balance = address(e).balance;
        vm.expectEmit(address(e));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.NoTwap);
        vm.prank(owner);
        assertEq(e.buyback(), 0);
        assertEq(address(e).balance, balance, "nothing spent on the run that records the first snapshot");
        assertEq(e.twapAt(), block.timestamp, "it recorded one");

        vm.warp(block.timestamp + MIN_WINDOW);
        feed.set(HBAR_USD, block.timestamp);
        vm.prank(owner);
        assertGt(e.buyback(), 0, "the next run has a window and buys");
    }

    function test_aPairWhoseCumulativeDidNotMoveReadsAsNoAverageNeverAsAZeroPrice() public {
        _pass(MIN_WINDOW);
        // The pair's accounting stands still while time passes: the difference since the snapshot is zero.
        pool.settleHistory(pool.token0() == address(furn), engine.twapCumulative(), block.timestamp);
        (FurnaceEngine.Skip state,,,) = engine.twap();
        assertEq(uint8(state), uint8(FurnaceEngine.Skip.NoTwap));
        assertEq(uint8(_skipNow()), uint8(FurnaceEngine.Skip.NoTwap));
        _expectSkip(FurnaceEngine.Skip.NoTwap);
        assertEq(_buyback(), 0);
    }

    function _skipNow() internal view returns (FurnaceEngine.Skip skip) {
        (skip,) = engine.previewBuyback();
    }

    // ---------------------------------------------------------------- the pool moved before the buy

    function test_aSwapRightBeforeTheBuyIsRefusedAndNothingIsSpent() public {
        _pump(40e8);
        (FurnaceEngine.Skip skip, uint256 spend) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation));
        assertEq(spend, 0);

        uint256 balance = address(engine).balance;
        uint256 supply = furn.totalSupply();
        uint256 swaps = router.swapCount();
        _expectSkip(FurnaceEngine.Skip.TwapDeviation);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, balance, "no HBAR left");
        assertEq(furn.totalSupply(), supply, "nothing burned");
        assertEq(router.swapCount(), swaps, "the engine never swapped");
        assertEq(engine.totalBurned(), 0);
    }

    function test_theSameRunWithoutTheSwapBuys() public {
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertGt(_buyback(), 0);
    }

    function test_deviationBoundary_justInsideBuysAndJustOutsideSkips() public {
        _moveReserves(1049e8, LIQUIDITY); // +4.9% against a 5% bound
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None), "4.9% above the average is inside");

        _moveReserves(1051e8, LIQUIDITY); // +5.1%
        (skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation), "5.1% above the average is outside");

        _moveReserves(1_050_05e6, LIQUIDITY); // +5.005%: a bound is never crossed by rounding
        (skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation), "five hundredths of a percent over is outside");
    }

    function test_aMoveDownIsNotRefused() public {
        _moveReserves(800e8, LIQUIDITY); // price down 20%: buying cheaper never hurts the engine
        (FurnaceEngine.Skip skip, uint256 spend) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertGt(spend, 0);
    }

    function test_aShortPumpBarelyMovesTheAverage() public {
        // The pool sat at the seed price for the hour, was pumped 30 seconds ago and still reads as a deviation.
        _pass(MIN_WINDOW);
        _pump(40e8);
        _pass(30);
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation));
    }

    function test_theAverageCatchesUpAfterTheMoveHoldsAndTheSnapshotRefreshHeals() public {
        _pump(40e8);
        _expectSkip(FurnaceEngine.Skip.TwapDeviation);
        _buyback();
        assertEq(engine.twapAt(), T0, "the refused run restarted the window");

        _pass(1 hours);
        (FurnaceEngine.Skip skip, uint256 spend) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None), "an hour at the new price is the new average");
        assertGt(spend, 0);
        assertGt(_buyback(), 0);
    }

    function test_theBoundFollowsTheOwnersSetting() public {
        _pump(40e8);
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation));
        vm.prank(owner);
        engine.setMaxTwapDeviationBps(1500);
        (skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None), "an 8% move is inside a 15% bound");
        vm.prank(owner);
        engine.setMaxTwapDeviationBps(50);
        (skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.TwapDeviation));
    }

    function test_capsAreCheckedBeforeTheTwapSoASkipNamesTheBindingCap() public {
        _pump(40e8);
        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        (FurnaceEngine.Skip skip,) = _preview();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.BudgetSpent), "the budget is named, not the average");
    }

    function test_scheduledRunRefusedByTheAverageNeitherRevertsNorStopsBooking() public {
        vm.prank(owner);
        engine.startAutomation(1 hours);
        MockHss.ScheduledCall memory c = hss.callAt(0);
        vm.warp(c.expirySecond);
        feed.set(HBAR_USD, block.timestamp);
        _pump(40e8);

        vm.recordLogs();
        vm.prank(c.to);
        (bool ok,) = c.to.call{ gas: c.gasLimit }(c.callData);
        assertTrue(ok, "a refused buy must not fail the scheduled transaction");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1, "the successor is booked");
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRun.selector), 1);
        assertEq(hss.callCount(), 2);
        assertEq(engine.runInterval(), 1 hours);
        assertEq(engine.totalBurned(), 0);
    }

    // ---------------------------------------------------------------- the views

    function test_twapViewReportsTheAverageTheWindowAndTheDeviation() public {
        (uint256 priceHbar, uint256 window, uint256 deviation) = _twapNow();
        (uint256 h, uint256 t) = _reserves();
        assertEq(window, POOL_AGE);
        assertApproxEqAbs(priceHbar, h * 10 ** DECIMALS / t, 1, "flat price, so the average is spot");
        assertEq(deviation, 0);

        _moveReserves(1050e8, LIQUIDITY);
        (priceHbar,, deviation) = _twapNow();
        assertApproxEqAbs(deviation, 500, 1, "5.0% above the average");
        assertApproxEqAbs(priceHbar, 1000e8 * 10 ** DECIMALS / LIQUIDITY, 1, "the average has not moved");
    }

    function test_twapViewNamesWhyThereIsNoAverage() public {
        _buyback();
        _pass(10);
        (FurnaceEngine.Skip state, uint256 priceHbar,,) = engine.twap();
        assertEq(uint8(state), uint8(FurnaceEngine.Skip.TwapWindow));
        assertEq(priceHbar, 0);
    }

    function test_statusCarriesTheAverageAndStaysReadableBeforeAnySnapshot() public {
        FurnaceEngine.Status memory s = engine.status();
        assertEq(s.twapWindow, POOL_AGE);
        assertApproxEqAbs(s.twapPriceHbar, s.priceHbar, 1);
        assertEq(s.twapDeviationBps, 0);
        _pump(40e8);
        s = engine.status();
        assertGt(s.twapDeviationBps, 500);
        assertLt(s.twapPriceHbar, s.priceHbar);

        FurnaceEngine bare = _deployEngine(_config());
        s = bare.status();
        assertEq(s.twapWindow, 0);
        assertEq(s.twapPriceHbar, 0);
    }

    // ---------------------------------------------------------------- the setting

    function test_setMaxTwapDeviation_isOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setMaxTwapDeviationBps(300);
    }

    function test_setMaxTwapDeviation_isBoundedAndEmits() public {
        uint256 min = engine.MIN_TWAP_DEVIATION_BPS();
        uint256 max = engine.MAX_TWAP_DEVIATION_BPS();
        assertEq(min, 50);
        assertEq(max, 2000);
        vm.startPrank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxTwapDeviationBps(min - 1);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxTwapDeviationBps(0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxTwapDeviationBps(max + 1);

        vm.expectEmit(address(engine));
        emit FurnaceEngine.MaxTwapDeviationSet(max);
        engine.setMaxTwapDeviationBps(max);
        assertEq(engine.maxTwapDeviationBps(), max);
        engine.setMaxTwapDeviationBps(min);
        assertEq(engine.maxTwapDeviationBps(), min);
        vm.stopPrank();
    }

    function test_constructor_refusesADeviationOutsideTheBounds() public {
        FurnaceEngine.Config memory c = _config();
        c.maxTwapDeviationBps = 0;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);
        c.maxTwapDeviationBps = 2001;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);
    }
}

interface MockHtsLike {
    function associate() external returns (int64);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The same suite with WHBAR sorting above the token, so the engine reads the other cumulative of the pair.
contract FurnaceTwapReversedOrderTest is FurnaceTwapTest {
    function whbarAddr() internal pure override returns (address) {
        return address(type(uint160).max);
    }

    function test_poolOrder_tokenIsToken0WhenWhbarSortsAbove() public view {
        assertEq(pool.token0(), address(furn));
    }
}
