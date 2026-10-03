// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

contract FurnaceAutomationTest is FurnaceBase {
    uint256 internal constant INTERVAL = 1 hours;
    int64 internal constant SUCCESS = 22;
    int64 internal constant EXPIRY_BUSY = 370;
    int64 internal constant NO_SCHEDULING_ALLOWED = 371;

    function setUp() public override {
        super.setUp();
        _ready();
        _revenue(500e8);
    }

    function _start() internal {
        vm.prank(owner);
        engine.startAutomation(INTERVAL);
    }

    // ---------------------------------------------------------------- startAutomation

    function test_start_isOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.startAutomation(INTERVAL);
        assertEq(hss.callCount(), 0);
    }

    function test_start_enforcesTheIntervalBounds() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BadInterval.selector, 59));
        engine.startAutomation(59);

        uint256 max = engine.MAX_INTERVAL();
        assertEq(max, 60 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BadInterval.selector, max + 1));
        engine.startAutomation(max + 1);

        vm.prank(owner);
        engine.startAutomation(60);
        assertEq(hss.callAt(0).expirySecond, T0 + 60);
        vm.prank(owner);
        engine.stopAutomation();
        vm.prank(owner);
        engine.startAutomation(max);
        assertEq(hss.callAt(1).expirySecond, T0 + max);
    }

    function test_start_booksARunnableScheduleToItselfWithTheConfiguredGas() public {
        vm.expectEmit(address(engine));
        emit FurnaceEngine.AutomationStarted(INTERVAL);
        _start();

        assertEq(hss.callCount(), 1);
        MockHss.ScheduledCall memory c = hss.callAt(0);
        assertEq(c.to, address(engine), "the engine schedules a call to itself");
        assertEq(c.expirySecond, T0 + INTERVAL);
        assertEq(c.gasLimit, SCHEDULED_GAS);
        assertGe(c.gasLimit, engine.MIN_SCHEDULED_GAS());
        assertEq(c.value, 0);
        assertEq(c.callData, abi.encodeCall(engine.runScheduled, ()));
        assertEq(c.responseCode, SUCCESS);

        assertEq(engine.runInterval(), INTERVAL);
        assertEq(engine.pendingSchedule(), c.schedule);
        assertTrue(c.schedule != address(0));
        assertEq(engine.nextRunAt(), c.expirySecond);
    }

    function test_start_cannotStartTwice() public {
        _start();
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.AutomationActive.selector);
        engine.startAutomation(INTERVAL);
        assertEq(hss.callCount(), 1);
    }

    function test_start_revertsWhenTheNetworkRefusesTheBooking() public {
        hss.setForcedCodes(NO_SCHEDULING_ALLOWED, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.ScheduleFailed.selector, NO_SCHEDULING_ALLOWED));
        engine.startAutomation(INTERVAL);
        assertEq(engine.runInterval(), 0, "a refused start leaves automation off");
        assertEq(engine.pendingSchedule(), address(0));
    }

    function test_start_probesLaterSecondsWhenTheIdealOneIsBusy() public {
        hss.setBusy(T0 + INTERVAL, true);
        _start();
        assertEq(hss.callAt(0).expirySecond, T0 + INTERVAL + 1);

        vm.prank(owner);
        engine.stopAutomation();
        hss.setBusy(T0 + INTERVAL + 1, true);
        hss.setBusy(T0 + INTERVAL + 2, true);
        _start();
        assertEq(hss.callAt(1).expirySecond, T0 + INTERVAL + 4, "probes +1, +2, +4");
    }

    function test_start_givesUpWhenEveryProbedSecondIsBusy() public {
        hss.setBusy(T0 + INTERVAL, true);
        for (uint256 d = 1; d <= 16; d *= 2) {
            hss.setBusy(T0 + INTERVAL + d, true);
        }
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.ScheduleFailed.selector, EXPIRY_BUSY));
        engine.startAutomation(INTERVAL);
    }

    // ---------------------------------------------------------------- stopAutomation

    function test_stop_deletesThePendingScheduleAndClearsState() public {
        _start();
        address pending = engine.pendingSchedule();
        vm.expectEmit(address(engine));
        emit FurnaceEngine.AutomationStopped();
        vm.prank(owner);
        engine.stopAutomation();

        assertEq(hss.lastDeleted(), pending);
        assertEq(hss.deleteCount(), 1);
        assertEq(engine.runInterval(), 0);
        assertEq(engine.pendingSchedule(), address(0));
        assertEq(engine.nextRunAt(), 0);
    }

    function test_stop_isOwnerOnlyAndHarmlessWhenIdle() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.stopAutomation();

        vm.prank(owner);
        engine.stopAutomation();
        assertEq(hss.deleteCount(), 0, "nothing pending, nothing to delete");
    }

    // ---------------------------------------------------------------- runScheduled

    function test_runScheduled_onlyTheEngineItselfMayCallIt() public {
        _start();
        vm.prank(alice);
        vm.expectRevert(FurnaceEngine.OnlySelf.selector);
        engine.runScheduled();
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.OnlySelf.selector);
        engine.runScheduled();
        vm.prank(keeper);
        vm.expectRevert(FurnaceEngine.OnlySelf.selector);
        engine.runScheduled();
        assertEq(hts.burnCount(), 0);
    }

    function test_runScheduled_booksItsSuccessorBeforeItBuysAndBurns() public {
        _start();
        vm.recordLogs();
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 booked = _indexOf(logs, FurnaceEngine.RunBooked.selector);
        uint256 burned = _indexOf(logs, FurnaceEngine.Burned.selector);
        uint256 ran = _indexOf(logs, FurnaceEngine.ScheduledRun.selector);
        assertTrue(booked != type(uint256).max && burned != type(uint256).max && ran != type(uint256).max);
        assertLt(booked, burned, "the successor is booked first");
        assertLt(burned, ran);
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1, "exactly one booking per scheduled run");
    }

    function test_runScheduled_buysAndBurnsOnTheNetworksSchedule() public {
        _start();
        uint256 supplyBefore = furn.totalSupply();
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);

        assertGt(engine.totalBurned(), 0);
        assertEq(supplyBefore - furn.totalSupply(), engine.totalBurned());
        assertEq(hss.callCount(), 2, "the run booked its successor");
        MockHss.ScheduledCall memory next = hss.callAt(1);
        assertEq(next.expirySecond, T0 + 2 * INTERVAL);
        assertEq(engine.pendingSchedule(), next.schedule);
        assertEq(engine.nextRunAt(), next.expirySecond);
        assertEq(engine.runInterval(), INTERVAL);
    }

    function test_runScheduled_chainsAndStaysInsideTheDailyBudget() public {
        vm.prank(owner);
        engine.setDailyBudgetUsd(5e8); // $5 a day is 25 HBAR
        _start();
        uint256 start = address(engine).balance;
        for (uint256 i; i < 6; ++i) {
            (bool ok,) = _runSchedule(i, true);
            assertTrue(ok);
            assertEq(hss.callCount(), i + 2);
        }
        // Six hourly runs fit in one 24 hour window, so together they spend at most the $5 budget.
        assertLe(start - address(engine).balance, 25e8, "six runs, one budget");
        assertLe(engine.spentTodayUsd(), 5e8);
        assertGe(address(engine).balance, FUEL, "scheduled buybacks leave the fuel alone");
    }

    function test_runScheduled_aSkippedRunStillKeepsTheChainAlive() public {
        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        _start();
        vm.recordLogs();
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRun.selector), 1);
        assertEq(hss.callCount(), 2);
        assertEq(engine.totalBurned(), 0);
    }

    function test_runScheduled_neverRevertsOnAStaleOracleAndKeepsTheChain() public {
        _start();
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1);
        vm.recordLogs();
        (bool ok,) = _runSchedule(0, false);
        assertTrue(ok, "a failed buyback must not fail the scheduled transaction");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRunFailed.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRun.selector), 0);
        assertEq(hss.callCount(), 2, "the successor was booked before the buyback failed");
        assertEq(engine.runInterval(), INTERVAL);
        assertEq(engine.totalBurned(), 0);
    }

    function test_runScheduled_neverRevertsWhenTheBurnFailsAndSpendsNothing() public {
        _start();
        hts.setForcedCodes(0, 0, 178);
        uint256 balance = address(engine).balance;
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        assertEq(address(engine).balance, balance, "the swap rolled back with the failed burn");
        assertEq(hss.callCount(), 2);
        assertEq(engine.totalBurned(), 0);
    }

    function test_runScheduled_aLostBookingTurnsAutomationOffButStillBuys() public {
        _start();
        hss.setForcedCodes(NO_SCHEDULING_ALLOWED, 0);
        vm.recordLogs();
        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countOf(logs, FurnaceEngine.BookingFailed.selector), 1);
        assertEq(engine.runInterval(), 0, "automation reads as off, so the owner can restart it");
        assertEq(engine.pendingSchedule(), address(0));
        assertEq(engine.nextRunAt(), 0);
        assertGt(engine.totalBurned(), 0, "this run's buyback still happened");

        hss.setForcedCodes(0, 0);
        _start();
        assertEq(engine.runInterval(), INTERVAL);
    }

    function test_runScheduled_afterAStopDoesNothing() public {
        _start();
        vm.prank(owner);
        engine.stopAutomation();
        uint256 calls = hss.callCount();
        vm.prank(address(engine));
        engine.runScheduled();
        assertEq(hss.callCount(), calls, "no booking");
        assertEq(engine.totalBurned(), 0, "and no buyback");
    }

    function test_runScheduled_beforeThePoolExistsSkipsAndKeepsBooking() public {
        FurnaceEngine fresh = _deployEngine(_config());
        vm.deal(address(fresh), 50e8);
        vm.prank(owner);
        fresh.startAutomation(INTERVAL);
        vm.recordLogs();
        MockHss.ScheduledCall memory c = hss.callAt(hss.callCount() - 1);
        vm.warp(c.expirySecond);
        feed.set(HBAR_USD, block.timestamp);
        vm.prank(c.to);
        (bool ok,) = c.to.call{ gas: c.gasLimit }(c.callData);
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1);
    }
}
