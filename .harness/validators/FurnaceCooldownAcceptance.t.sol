// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

/// Owned by the harness, not the agent. `.harness/validators/acceptance.sh` copies it into packages/foundry/test,
/// runs it against whatever the agent wrote, and removes it. It pins the interface the PRD names and the rules the
/// engine must keep while it adds a buyback cooldown.
contract FurnaceCooldownAcceptanceTest is FurnaceBase {
    uint256 internal constant COOLDOWN = 2 hours;
    uint256 internal constant INTERVAL = 1 hours;

    function setUp() public override {
        super.setUp();
        _ready();
        _revenue(500e8);
    }

    function _setCooldown(uint256 value) internal {
        vm.prank(owner);
        engine.setBuybackCooldown(value);
    }

    // ---------------------------------------------------------------- the setter

    function test_cooldownIsOffByDefaultAndBackToBackBuybacksStillWork() public {
        assertEq(engine.buybackCooldown(), 0);
        assertEq(engine.lastBuybackAt(), 0);
        assertGt(_buyback(), 0);
        assertGt(_buyback(), 0, "no cooldown set, so a second buyback in the same second spends");
    }

    function test_setter_isOwnerOnlyBoundedAndEmits() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setBuybackCooldown(1 hours);
        assertEq(engine.buybackCooldown(), 0, "a rejected call changes nothing");

        assertEq(engine.MAX_BUYBACK_COOLDOWN(), 1 days);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setBuybackCooldown(1 days + 1);
        assertEq(engine.buybackCooldown(), 0);

        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackCooldownSet(1 days);
        _setCooldown(1 days);
        assertEq(engine.buybackCooldown(), 1 days, "the maximum itself is allowed");

        _setCooldown(0);
        assertEq(engine.buybackCooldown(), 0, "zero switches the cooldown off");
    }

    // ---------------------------------------------------------------- the rule

    function test_buyback_insideTheCooldownSkipsWithCooldownAndMovesNothing() public {
        _setCooldown(COOLDOWN);
        uint256 first = _buyback();
        assertGt(first, 0);
        assertEq(engine.lastBuybackAt(), T0);

        vm.warp(T0 + COOLDOWN - 1);
        feed.set(HBAR_USD, block.timestamp);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.Cooldown), "the dry run names the cooldown");
        assertEq(spend, 0);

        uint256 balance = address(engine).balance;
        uint256 supply = furn.totalSupply();
        uint256 burned = engine.totalBurned();
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.Cooldown);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, balance, "a skipped run spends nothing");
        assertEq(furn.totalSupply(), supply, "and burns nothing");
        assertEq(engine.totalBurned(), burned);
        assertEq(engine.lastBuybackAt(), T0, "a skip does not restart the cooldown");
    }

    function test_buyback_reopensExactlyWhenTheCooldownHasElapsedFromTheLastSpend() public {
        _setCooldown(COOLDOWN);
        _buyback();
        vm.warp(T0 + COOLDOWN - 1);
        feed.set(HBAR_USD, block.timestamp);
        assertEq(_buyback(), 0, "one second early is still cooling down");

        vm.warp(T0 + COOLDOWN);
        feed.set(HBAR_USD, block.timestamp);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertGt(_buyback(), 0, "measured from the last spend, not from the skipped attempt");
        assertEq(engine.lastBuybackAt(), T0 + COOLDOWN);
    }

    function test_buyback_aRunThatSpendsNothingForAnotherReasonDoesNotStartTheCooldown() public {
        _setCooldown(COOLDOWN);
        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        assertEq(_buyback(), 0);
        assertEq(engine.lastBuybackAt(), 0, "BudgetSpent is not a buyback");
        vm.prank(owner);
        engine.setDailyBudgetUsd(DAILY_BUDGET_USD);
        assertGt(_buyback(), 0, "and the first real buyback is not held back");
    }

    function test_preview_insideTheCooldownReadsNoOracle() public {
        _setCooldown(COOLDOWN);
        _buyback();
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.Cooldown), "the cooldown is checked before the oracle is read");
        assertEq(spend, 0);
    }

    function test_buyback_theOwnerIsHeldToTheCooldownToo() public {
        _setCooldown(COOLDOWN);
        _buyback();
        vm.prank(owner);
        assertEq(engine.buyback(), 0);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.Cooldown));
    }

    function test_buyback_stillBurnsOnlyWhatItBoughtAcrossCooldownRuns() public {
        _setCooldown(COOLDOWN);
        _buyback();
        _buyback();
        vm.warp(T0 + COOLDOWN);
        feed.set(HBAR_USD, block.timestamp);
        _buyback();
        assertEq(furn.totalSupply(), TOTAL_SUPPLY - engine.totalBurned(), "every unit of supply lost is a bought burn");
        assertGe(furn.balanceOf(address(engine)), engine.teamUnclaimed() + engine.liquidityUnseeded());
        assertGe(address(engine).balance, FUEL, "the fuel reserve is untouched");
    }

    // ---------------------------------------------------------------- automation

    function test_scheduledRun_insideTheCooldownNeverRevertsAndKeepsBooking() public {
        _setCooldown(COOLDOWN);
        vm.prank(owner);
        engine.startAutomation(INTERVAL);

        (bool ok,) = _runSchedule(0, true);
        assertTrue(ok);
        uint256 burnedAfterFirst = engine.totalBurned();
        assertGt(burnedAfterFirst, 0, "the first scheduled run buys");
        assertEq(hss.callCount(), 2);

        vm.recordLogs();
        (ok,) = _runSchedule(1, true);
        assertTrue(ok, "a run inside the cooldown must not fail the scheduled transaction");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.BuybackSkipped.selector), 1, "it names the skip");
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRun.selector), 1);
        assertEq(_countOf(logs, FurnaceEngine.ScheduledRunFailed.selector), 0, "a cooldown skip is not a failure");
        assertEq(_countOf(logs, FurnaceEngine.RunBooked.selector), 1, "exactly one booking, made first");
        assertLt(
            _indexOf(logs, FurnaceEngine.RunBooked.selector),
            _indexOf(logs, FurnaceEngine.BuybackSkipped.selector),
            "book first, then decide"
        );
        assertEq(hss.callCount(), 3, "the chain continues");
        assertEq(engine.totalBurned(), burnedAfterFirst);

        (ok,) = _runSchedule(2, true);
        assertTrue(ok);
        assertGt(engine.totalBurned(), burnedAfterFirst, "the run after the cooldown buys again");
        assertEq(hss.callCount(), 4);
    }
}
