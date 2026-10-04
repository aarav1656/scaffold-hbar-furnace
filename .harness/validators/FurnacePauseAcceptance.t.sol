// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// Owned by the harness, not the agent. `.harness/validators/acceptance.sh` copies it into packages/foundry/test,
/// runs it against whatever the agent wrote, and removes it. It pins the interface the PRD names and the rules the
/// engine must keep while it adds a buyback pause.
contract FurnacePauseAcceptanceTest is FurnaceBase {
    uint256 internal constant INTERVAL = 1 hours;

    function setUp() public override {
        super.setUp();
        _ready();
        _revenue(500e8);
    }

    function _pause(bool value) internal {
        vm.prank(owner);
        engine.setBuybacksPaused(value);
    }

    // ---------------------------------------------------------------- the setter

    function test_pauseIsOffByDefaultAndBuybacksStillWork() public {
        assertFalse(engine.buybacksPaused());
        assertGt(_buyback(), 0);
    }

    function test_setter_isOwnerOnlyAndEmitsBothWays() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setBuybacksPaused(true);
        assertFalse(engine.buybacksPaused(), "a rejected call changes nothing");

        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybacksPausedSet(true);
        _pause(true);
        assertTrue(engine.buybacksPaused());

        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybacksPausedSet(false);
        _pause(false);
        assertFalse(engine.buybacksPaused());
    }

    // ---------------------------------------------------------------- the rule

    function test_buyback_whilePausedSkipsWithPausedAndMovesNothing() public {
        _pause(true);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.Paused), "the dry run names the pause");
        assertEq(spend, 0);

        uint256 balance = address(engine).balance;
        uint256 supply = furn.totalSupply();
        uint256 swaps = router.swapCount();
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.Paused);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, balance, "a paused run spends nothing");
        assertEq(furn.totalSupply(), supply, "and burns nothing");
        assertEq(router.swapCount(), swaps, "and never reaches the router");
        assertEq(engine.totalBurned(), 0);
    }

    function test_unpausingResumesBuying() public {
        _pause(true);
        assertEq(_buyback(), 0);
        _pause(false);
        _pass(MIN_WINDOW);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertGt(_buyback(), 0);
    }

    function test_preview_whilePausedReadsNoOracle() public {
        _pause(true);
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.Paused), "the pause is checked before the oracle is read");
        assertEq(spend, 0);
    }

    function test_pausedRunsLeaveTheSpendLedgerAlone() public {
        _pause(true);
        _buyback();
        _buyback();
        assertEq(engine.spentTodayUsd(), 0);
        assertEq(engine.totalSpentHbar(), 0);
        assertEq(engine.lastBuyAt(), 0, "a pause skip is not a buy");
    }

    function test_pauseTrapsNothing() public {
        _pause(true);
        uint256 balance = address(engine).balance;
        _revenue(10e8);
        assertEq(address(engine).balance, balance + 10e8, "a paused engine still takes revenue");

        vm.startPrank(owner);
        engine.setDailyBudgetUsd(7e8);
        engine.startAutomation(INTERVAL);
        engine.stopAutomation();
        vm.stopPrank();
        assertEq(engine.dailyBudgetUsd(), 7e8, "policy stays settable while paused");
        assertEq(owner.balance, 0, "no HBAR reaches the owner");
    }

    function test_burnsStayOnlyWhatWasBoughtAcrossPauseCycles() public {
        assertGt(_buyback(), 0);
        _pause(true);
        _pass(MIN_WINDOW);
        _buyback();
        _pause(false);
        _pass(MIN_WINDOW);
        assertGt(_buyback(), 0);
        assertEq(furn.totalSupply(), TOTAL_SUPPLY - engine.totalBurned(), "every unit of supply lost is a bought burn");
        assertGe(furn.balanceOf(address(engine)), engine.teamUnclaimed() + engine.liquidityUnseeded());
        assertGe(address(engine).balance, FUEL, "the fuel reserve is untouched");
    }

    // ---------------------------------------------------------------- automation

    function test_scheduledRun_whilePausedNeverRevertsAndKeepsBooking() public {
        vm.prank(owner);
        engine.startAutomation(INTERVAL);
        _pause(true);

        vm.recordLogs();
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok, "a paused run must not fail the scheduled transaction");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1, "it names the skip");
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRun.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRunFailed.selector), 0, "a pause is not a failure");
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1, "exactly one booking, made first");
        assertLt(
            _indexOf(logs, FurnaceEngine.RunBooked.selector),
            _indexOf(logs, FurnaceEngine.BuybackSkipped.selector),
            "book first, then decide"
        );
        assertEq(hss.callCount(), 2, "the chain continues");
        assertEq(engine.runInterval(), INTERVAL);
        assertEq(engine.totalBurned(), 0);

        _pause(false);
        (ok,) = _runSchedule(1, true);
        assertTrue(ok);
        assertGt(engine.totalBurned(), 0, "the first run after unpausing buys");
        assertEq(hss.callCount(), 3);
    }
}
