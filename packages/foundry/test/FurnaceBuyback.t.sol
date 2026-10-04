// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

contract FurnaceBuybackTest is FurnaceBase {
    /// Spot price of the seeded pool: $0.0005 per token at $0.20 per HBAR, 8 decimals.
    uint256 internal constant SPOT_USD = 50_000;

    function setUp() public virtual override {
        super.setUp();
        _ready();
    }

    function _path() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = whbarAddr();
        path[1] = address(furn);
    }

    function _quote(uint256 hbar) internal view returns (uint256) {
        return router.getAmountsOut(hbar, _path())[1];
    }

    function _expectSkip(FurnaceEngine.Skip reason) internal {
        vm.expectEmit(address(engine));
        emit FurnaceEngine.BuybackSkipped(reason);
    }

    function _impactCap(uint256 reserveHbar, uint256 bps) internal pure returns (uint256) {
        return reserveHbar * bps / (10_000 - bps);
    }

    /// Sets the engine's native balance to exactly `fuel + spendable`.
    function _setBalance(uint256 spendable) internal {
        vm.deal(address(engine), FUEL + spendable);
    }

    // ---------------------------------------------------------------- sizing: price impact

    function test_impactCap_bindsWhenRevenueIsLarge() public {
        _revenue(100e8);
        uint256 cap = _impactCap(SEED_HBAR, MAX_IMPACT_BPS);
        assertEq(cap, 5_263_157_894);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        assertEq(spend, cap, "98 HBAR is available and 500 HBAR of budget, so the 5% impact cap sets the size");

        uint256 before = address(engine).balance;
        _buyback();
        assertEq(before - address(engine).balance, cap);
        assertEq(router.lastSwapValue(), cap, "the swap value is tinybar, exactly the planned spend");
    }

    function test_impactCap_matchesConstantProductPriceImpact() public {
        _revenue(100e8);
        (uint256 rHbar,) = _reserves();
        uint256 spendHbar = _impactCap(rHbar, MAX_IMPACT_BPS);
        // Price impact is how far the fill lands below the pre-trade spot price: x / (R + x). Add the pool's 0.3% fee
        // and the realised shortfall is that plus about 30 bps.
        assertLe(_impactBps(spendHbar, rHbar), MAX_IMPACT_BPS);
        assertGe(_impactBps(spendHbar, rHbar), MAX_IMPACT_BPS - 1, "the cap is tight, not conservative by a mile");

        (, uint256 rToken) = _reserves();
        uint256 spotOut = spendHbar * rToken / rHbar;
        uint256 out = _buyback();
        uint256 shortfallBps = (spotOut - out) * 10_000 / spotOut;
        assertGe(shortfallBps, MAX_IMPACT_BPS, "fill is below spot by at least the impact");
        assertLe(shortfallBps, MAX_IMPACT_BPS + 31, "and by no more than the impact plus the pool fee");
    }

    function test_impactCap_followsThePoolDepthAndTheSetting() public {
        _revenue(1000e8);
        _setPoolReserves(2 * SEED_HBAR, LIQUIDITY);
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, _impactCap(2 * SEED_HBAR, MAX_IMPACT_BPS), "a deeper pool takes a bigger buyback");

        vm.prank(owner);
        engine.setMaxImpactBps(1000);
        (, spend) = engine.previewBuyback();
        assertEq(spend, _impactCap(2 * SEED_HBAR, 1000));

        vm.prank(owner);
        engine.setMaxImpactBps(100);
        (, spend) = engine.previewBuyback();
        assertEq(spend, _impactCap(2 * SEED_HBAR, 100));
    }

    function test_impactCap_belowMinSpendSkipsTheRun() public {
        _revenue(100e8);
        _setPoolReserves(10e8, LIQUIDITY);
        assertLt(_impactCap(10e8, MAX_IMPACT_BPS), MIN_SPEND);
        _expectSkip(FurnaceEngine.Skip.ImpactCap);
        uint256 before = address(engine).balance;
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, before, "a skipped run spends nothing");
        assertEq(hts.burnCount(), 0);
    }

    // ---------------------------------------------------------------- sizing: funds and fuel

    function test_funds_spendIsAllRevenueAboveTheFuelReserve() public {
        _setBalance(18e8);
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, 18e8);
        _buyback();
        assertEq(address(engine).balance, FUEL, "the fuel reserve is never spent on buybacks");
    }

    function test_funds_nothingAboveTheReserveSkipsTheRun() public {
        _setBalance(0);
        _expectSkip(FurnaceEngine.Skip.NoFunds);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, FUEL);

        vm.deal(address(engine), FUEL / 2);
        _expectSkip(FurnaceEngine.Skip.NoFunds);
        assertEq(_buyback(), 0);
        assertEq(address(engine).balance, FUEL / 2, "a balance below the reserve is not touched either");
    }

    function test_funds_minSpendBoundary() public {
        _setBalance(MIN_SPEND - 1);
        _expectSkip(FurnaceEngine.Skip.NoFunds);
        assertEq(_buyback(), 0);

        _pass(60);
        _setBalance(MIN_SPEND);
        uint256 burned = _buyback();
        assertGt(burned, 0, "exactly minSpend is enough");
        assertEq(address(engine).balance, FUEL);
        assertEq(router.lastSwapValue(), MIN_SPEND);
    }

    // ---------------------------------------------------------------- sizing: daily budget

    function test_budget_capsTheSpendInUsd() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setDailyBudgetUsd(2e8); // $2 is 10 HBAR at $0.20
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, 10e8);

        _buyback();
        assertEq(engine.spentTodayUsd(), 2e8);
        assertEq(engine.windowStart(), T0);
        assertEq(engine.totalSpentHbar(), 10e8);
    }

    function test_budget_exhaustedSkipsUntilTheWindowRolls() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setDailyBudgetUsd(2e8);
        _buyback();

        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        assertEq(_buyback(), 0);

        vm.warp(T0 + 1 days - 1);
        feed.set(HBAR_USD, block.timestamp);
        (FurnaceEngine.Skip early,) = engine.previewBuyback();
        assertEq(uint8(early), uint8(FurnaceEngine.Skip.BudgetSpent), "one second early: the window has not rolled");
        assertEq(engine.spentTodayUsd(), 2e8);

        vm.warp(T0 + 1 days);
        feed.set(HBAR_USD, block.timestamp);
        uint256 burned = _buyback();
        assertGt(burned, 0, "24 hours after the first spend the budget is back");
        assertEq(engine.windowStart(), T0 + 1 days);
        assertEq(engine.spentTodayUsd(), 2e8, "the new window holds only the new spend");
    }

    function test_budget_isSharedAcrossRunsInTheWindow() public {
        _revenue(200e8);
        vm.startPrank(owner);
        engine.setDailyBudgetUsd(3e8); // 15 HBAR
        engine.setMaxImpactBps(100); // about 10 HBAR a run on this pool
        vm.stopPrank();

        uint256 start = address(engine).balance;
        _buyback();
        uint256 firstSpend = start - address(engine).balance;
        assertGt(firstSpend, 9e8);
        assertLt(firstSpend, 11e8);

        _pass(60);
        _buyback();
        uint256 total = start - address(engine).balance;
        assertLe(total, 15e8, "two runs together stay inside the daily budget");
        assertGe(total, 15e8 - 1, "and use all of it");
        assertLe(engine.spentTodayUsd(), 3e8);

        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        assertEq(_buyback(), 0);
    }

    function test_budget_usdCostRoundsUpSoTheBudgetCannotBeOvershot() public {
        _revenue(100e8);
        // 3 tinybar per cent-of-a-cent of rounding: a price that makes spend * price / 1e8 fractional.
        feed.set(int256(33_333_333), block.timestamp);
        vm.prank(owner);
        engine.setDailyBudgetUsd(1e8);
        (, uint256 spend) = engine.previewBuyback();
        _buyback();
        uint256 usd = engine.spentTodayUsd();
        assertEq(usd, Math.mulDiv(spend, 33_333_333, 1e8, Math.Rounding.Ceil));
        assertLe(usd, 1e8);
    }

    function test_budget_belowMinSpendOrZeroSkipsTheRun() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setDailyBudgetUsd(1e7); // $0.10 is 0.5 HBAR, under the 1 HBAR minimum
        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        assertEq(_buyback(), 0);

        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        _expectSkip(FurnaceEngine.Skip.BudgetSpent);
        assertEq(_buyback(), 0);
    }

    function test_budget_followsTheHbarPrice() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setDailyBudgetUsd(2e8);
        (, uint256 atTwenty) = engine.previewBuyback();
        feed.set(HBAR_USD / 2, block.timestamp); // HBAR halves to $0.10: the same $2 buys twice the HBAR
        (, uint256 atTen) = engine.previewBuyback();
        assertEq(atTwenty, 10e8);
        assertEq(atTen, 20e8);
    }

    // ---------------------------------------------------------------- sizing: price ceiling

    function test_ceiling_spotAtOrAboveItSkipsTheRun() public {
        _revenue(100e8);
        vm.startPrank(owner);
        engine.setPriceCeilingUsd(SPOT_USD - 1);
        vm.stopPrank();
        _expectSkip(FurnaceEngine.Skip.PriceCeiling);
        assertEq(_buyback(), 0);

        vm.prank(owner);
        engine.setPriceCeilingUsd(SPOT_USD);
        _expectSkip(FurnaceEngine.Skip.PriceCeiling);
        assertEq(_buyback(), 0);
        assertEq(hts.burnCount(), 0);
    }

    function test_ceiling_justAboveSpotClampsTheSpendSoThePriceNeverPassesIt() public {
        _revenue(100e8);
        uint256 ceiling = 51_000; // 2% above spot
        vm.prank(owner);
        engine.setPriceCeilingUsd(ceiling);

        (, uint256 spend) = engine.previewBuyback();
        assertLt(spend, _impactCap(SEED_HBAR, MAX_IMPACT_BPS), "the ceiling, not the impact cap, binds");
        // R * (sqrt(1.02) - 1) = about 9.95 HBAR out of a 1000 HBAR pool
        assertApproxEqAbs(spend, 9.95e8, 0.01e8);

        _buyback();
        (uint256 rHbar, uint256 rToken) = _reserves();
        assertLe(rHbar * HBAR_USD_U, ceiling * rToken, "the post-trade spot price is at or under the ceiling");
        assertGt(_spotUsd(), SPOT_USD, "and the buyback did move the price up");
    }

    function test_ceiling_farAboveSpotLeavesTheImpactCapInCharge() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setPriceCeilingUsd(100_000);
        (, uint256 spend) = engine.previewBuyback();
        assertEq(spend, _impactCap(SEED_HBAR, MAX_IMPACT_BPS));

        vm.prank(owner);
        engine.setPriceCeilingUsd(type(uint64).max);
        (, spend) = engine.previewBuyback();
        assertEq(spend, _impactCap(SEED_HBAR, MAX_IMPACT_BPS), "a huge ceiling is no ceiling");
    }

    function test_ceiling_zeroMeansNone() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setPriceCeilingUsd(1);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.PriceCeiling));
        vm.prank(owner);
        engine.setPriceCeilingUsd(0);
        (skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
    }

    function test_ceiling_isInUsdSoTheHbarPriceMovesIt() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setPriceCeilingUsd(60_000);
        (FurnaceEngine.Skip skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None), "spot $0.0005 is under a $0.0006 ceiling");

        feed.set(HBAR_USD * 2, block.timestamp); // HBAR doubles, so the token's USD spot doubles to 100,000
        (skip,) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.PriceCeiling));
    }

    // ---------------------------------------------------------------- oracle

    function test_oracle_staleAnswerRevertsTheBuyback() public {
        _revenue(100e8);
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.StaleOracle.selector, T0 - MAX_ORACLE_AGE - 1));
        engine.buyback();
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.StaleOracle.selector, T0 - MAX_ORACLE_AGE - 1));
        engine.previewBuyback();
        assertEq(hts.burnCount(), 0);
    }

    function test_oracle_ageExactlyAtTheLimitIsStillFresh() public {
        _revenue(100e8);
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE);
        assertGt(_buyback(), 0);
    }

    function test_oracle_nonPositiveAnswerReverts() public {
        _revenue(100e8);
        feed.set(0, T0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BadOraclePrice.selector, int256(0)));
        engine.buyback();
        feed.set(-5, T0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.BadOraclePrice.selector, int256(-5)));
        engine.buyback();
    }

    function test_oracle_hbarUsdViewMatchesTheFeed() public {
        assertEq(engine.hbarUsd(), HBAR_USD_U);
        feed.set(12_345_678, T0);
        assertEq(engine.hbarUsd(), 12_345_678);
    }

    // ---------------------------------------------------------------- readiness

    function test_notReady_beforeThePoolHasLiquiditySkipsWithoutAnOracle() public {
        FurnaceEngine fresh = _deployEngine(_config());
        feed.set(0, 0); // a dead feed must not matter before the pool exists
        vm.expectEmit(address(fresh));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.NotReady);
        vm.prank(owner);
        assertEq(fresh.buyback(), 0);

        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        fresh.initialize{ value: INIT_VALUE }("Other", "OTH", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY));
        uint256 fee = fresh.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        fresh.createPool{ value: fee }();
        vm.expectEmit(address(fresh));
        emit FurnaceEngine.BuybackSkipped(FurnaceEngine.Skip.NotReady);
        vm.prank(owner);
        assertEq(fresh.buyback(), 0);
    }

    // ---------------------------------------------------------------- access

    function test_buyback_isOwnerOrSelfOnly() public {
        _revenue(100e8);
        vm.prank(alice);
        vm.expectRevert(FurnaceEngine.NotOwnerOrSelf.selector);
        engine.buyback();
        vm.prank(keeper);
        vm.expectRevert(FurnaceEngine.NotOwnerOrSelf.selector);
        engine.buyback();
        assertEq(hts.burnCount(), 0);

        vm.prank(owner);
        assertGt(engine.buyback(), 0);
        _pass(60);
        vm.prank(address(engine));
        assertGt(engine.buyback(), 0);
    }

    // ---------------------------------------------------------------- the burn

    function test_burn_removesExactlyWhatWasBoughtFromTotalSupply() public {
        _revenue(100e8);
        uint256 poolBefore = furn.balanceOf(address(pool));
        uint256 supplyBefore = furn.totalSupply();
        uint256 engineBefore = furn.balanceOf(address(engine));

        uint256 burned = _buyback();

        assertGt(burned, 0);
        assertEq(poolBefore - furn.balanceOf(address(pool)), burned, "what left the pool is what was burned");
        assertEq(supplyBefore - furn.totalSupply(), burned, "total supply fell by exactly the bought amount");
        assertEq(furn.balanceOf(address(engine)), engineBefore, "the treasury ends where it started");
        assertEq(engine.totalBurned(), burned);
        assertEq(hts.burnCount(), 1);
    }

    function test_burn_emitsPriceAndSupplyAfter() public {
        _revenue(100e8);
        uint256 spend = _impactCap(SEED_HBAR, MAX_IMPACT_BPS);
        uint256 out = _quote(spend);
        uint256 priceHbar = spend * 1e8 / out;
        vm.expectEmit(address(engine));
        emit FurnaceEngine.Burned(spend, out, priceHbar, priceHbar * HBAR_USD_U / 1e8, TOTAL_SUPPLY - out);
        _buyback();
    }

    function test_burn_neverTouchesTheTeamOrLiquidityAllocations() public {
        _revenue(500e8);
        for (uint256 i; i < 4; ++i) {
            _buyback();
            assertEq(
                furn.balanceOf(address(engine)),
                engine.teamUnclaimed() + engine.liquidityUnseeded(),
                "the treasury holds exactly the unclaimed allocations"
            );
        }
        assertEq(engine.teamUnclaimed(), TEAM);
        assertEq(furn.totalSupply(), TOTAL_SUPPLY - engine.totalBurned());
    }

    function test_burn_withAnUnseededAllocationStillBurnsOnlyBoughtTokens() public {
        // A fresh engine whose pool took only part of the liquidity allocation.
        FurnaceEngine e = _deployEngine(_config());
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        e.initialize{ value: INIT_VALUE }("Two", "TWO", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY));
        uint256 fee = e.poolCreationFee();
        vm.deal(owner, fee + 1000e8);
        vm.startPrank(owner);
        e.createPool{ value: fee }();
        vm.stopPrank();
        // Skew the new pair so the router takes only 100,000 of the 400,000 tokens.
        MockPairLike p = MockPairLike(e.pair());
        if (p.token0() == e.token()) p.setReserves(100_000e8, 1000e8);
        else p.setReserves(1000e8, 100_000e8);
        vm.prank(owner);
        e.seedLiquidity{ value: 1000e8 }(0, 0);
        assertEq(e.liquidityUnseeded(), 300_000e8);

        vm.deal(address(e), FUEL + 100e8);
        _pass(60);
        vm.prank(owner);
        assertGt(e.buyback(), 0);
        assertEq(IBalance(e.token()).balanceOf(address(e)), e.teamUnclaimed() + e.liquidityUnseeded());
    }

    function test_burn_htsRefusalRevertsTheWholeRunAndKeepsTheHbar() public {
        _revenue(100e8);
        hts.setForcedCodes(0, 0, 178);
        uint256 balance = address(engine).balance;
        uint256 poolTokens = furn.balanceOf(address(pool));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.HtsCallFailed.selector, int64(178)));
        engine.buyback();
        assertEq(address(engine).balance, balance, "the swap was rolled back with the failed burn");
        assertEq(furn.balanceOf(address(pool)), poolTokens);
        assertEq(engine.totalSpentHbar(), 0);
        assertEq(engine.spentTodayUsd(), 0);
        assertEq(engine.totalBurned(), 0);
    }

    function test_burn_aBurnThatTakesMoreThanWasBoughtIsCaughtAndRolledBack() public {
        _revenue(100e8);
        hts.setBurnExtra(1); // an HTS that burns one more unit than asked eats into the allocations
        uint256 balance = address(engine).balance;
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.AllocationBreach.selector);
        engine.buyback();
        assertEq(address(engine).balance, balance);
        assertEq(furn.totalSupply(), TOTAL_SUPPLY, "nothing was burned");
    }

    function test_burn_aFillThatDeliversNothingRevertsInsteadOfBurningZero() public {
        _revenue(100e8);
        router.setStingy(true);
        uint256 balance = address(engine).balance;
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.NothingBought.selector);
        engine.buyback();
        assertEq(address(engine).balance, balance);
        assertEq(hts.burnCount(), 0);
    }

    function test_slippage_aMarketThatMovedPastTheToleranceRevertsTheRun() public {
        _revenue(100e8);
        router.setHaircutBps(10_000);
        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_OUTPUT_AMOUNT");
        engine.buyback();
    }

    // ---------------------------------------------------------------- slippage

    function test_slippage_aFillAtTheToleranceStandsAndOneBpWorseReverts() public {
        _revenue(100e8);
        router.setHaircutBps(SLIPPAGE_BPS);
        assertGt(_buyback(), 0, "a fill exactly slippageBps under the quote is accepted");

        _pass(60);
        router.setHaircutBps(SLIPPAGE_BPS + 1);
        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_OUTPUT_AMOUNT");
        engine.buyback();
    }

    function test_slippage_zeroToleranceRejectsAnyShortfall() public {
        _revenue(100e8);
        vm.prank(owner);
        engine.setSlippageBps(0);
        router.setHaircutBps(1);
        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_OUTPUT_AMOUNT");
        engine.buyback();
    }

    // ---------------------------------------------------------------- views

    function test_preview_namesWhatBuybackThenDoes() public {
        _revenue(100e8);
        (FurnaceEngine.Skip skip, uint256 spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.None));
        uint256 before = address(engine).balance;
        _buyback();
        assertEq(before - address(engine).balance, spend);

        vm.prank(owner);
        engine.setDailyBudgetUsd(0);
        (skip, spend) = engine.previewBuyback();
        assertEq(uint8(skip), uint8(FurnaceEngine.Skip.BudgetSpent));
        assertEq(spend, 0);
    }

    function test_status_beforeAnythingExistsDoesNotRevert() public {
        FurnaceEngine fresh = _deployEngine(_config());
        FurnaceEngine.Status memory s = fresh.status();
        assertEq(s.token, address(0));
        assertEq(s.totalSupply, 0);
        assertEq(s.priceUsd, 0);
        assertEq(s.hbarUsd, HBAR_USD_U);
        assertEq(s.fuel, FUEL);
    }

    function test_status_readsTheLivePoolAndTheBuybackLedger() public {
        _revenue(100e8);
        FurnaceEngine.Status memory s = engine.status();
        assertEq(s.token, address(furn));
        assertEq(s.pair, address(pool));
        assertEq(s.lpToken, address(lp));
        assertEq(s.totalSupply, TOTAL_SUPPLY);
        assertEq(s.reserveHbar, SEED_HBAR);
        assertEq(s.reserveToken, LIQUIDITY);
        assertEq(s.priceHbar, 250_000, "0.0025 HBAR per token in tinybar");
        assertEq(s.priceUsd, SPOT_USD);
        assertEq(s.teamUnclaimed, TEAM);
        assertEq(s.balance, address(engine).balance);
        assertEq(s.budgetLeftUsd, DAILY_BUDGET_USD);

        uint256 burned = _buyback();
        s = engine.status();
        assertEq(s.totalBurned, burned);
        assertEq(s.totalSupply, TOTAL_SUPPLY - burned);
        assertEq(s.totalSpentHbar, 5_263_157_894);
        assertEq(s.spentTodayUsd, 1_052_631_579, "ceil(52.63157894 HBAR x $0.20)");
        assertEq(s.budgetLeftUsd, DAILY_BUDGET_USD - 1_052_631_579);
        assertGt(s.priceUsd, SPOT_USD, "buying moved the price up");
    }

    function test_status_staysReadableWhenTheOracleGoesStale() public {
        feed.set(HBAR_USD, T0 - MAX_ORACLE_AGE - 1);
        FurnaceEngine.Status memory s = engine.status();
        assertEq(s.hbarUsd, 0);
        assertEq(s.priceUsd, 0);
        assertEq(s.priceHbar, 250_000, "the HBAR price needs no oracle");
    }

    function test_status_budgetWindowReadsZeroSpendOnceItHasExpired() public {
        _revenue(100e8);
        _buyback();
        assertGt(engine.status().spentTodayUsd, 0);
        vm.warp(T0 + 1 days);
        assertEq(engine.status().spentTodayUsd, 0);
        assertEq(engine.status().budgetLeftUsd, DAILY_BUDGET_USD);
    }

    // ---------------------------------------------------------------- pool ordering

    function test_poolOrder_matchesTheAddressSort() public view {
        assertEq(pool.token0() == whbarAddr(), whbarAddr() < address(furn));
    }

    // ---------------------------------------------------------------- fuzz

    /// Whatever the revenue, budget, impact, ceiling, pool depth and HBAR price, a buyback never spends more than the
    /// smallest of its four caps, never touches the fuel reserve, never overshoots the day's budget and never leaves
    /// the pool priced above the ceiling.
    function testFuzz_spendNeverExceedsTheTightestCap(
        uint256 revenue,
        uint256 budgetUsd,
        uint256 impactBps,
        uint256 ceiling,
        uint256 rHbar,
        uint256 rToken,
        uint256 hbarPrice
    ) public {
        revenue = bound(revenue, 0, 5000e8);
        budgetUsd = bound(budgetUsd, 0, 1000e8);
        impactBps = bound(impactBps, 1, 1000);
        rHbar = bound(rHbar, 5e8, 100_000e8);
        rToken = bound(rToken, 1000e8, LIQUIDITY);
        hbarPrice = bound(hbarPrice, 1e6, 1e9);
        _setPoolReserves(rHbar, rToken);
        feed.set(int256(hbarPrice), block.timestamp);
        uint256 spotUsd = rHbar * hbarPrice / rToken;
        ceiling = bound(ceiling, 0, spotUsd * 3 + 10);
        vm.startPrank(owner);
        engine.setDailyBudgetUsd(budgetUsd);
        engine.setMaxImpactBps(impactBps);
        engine.setPriceCeilingUsd(ceiling);
        vm.stopPrank();
        _revenue(revenue);

        uint256 balanceBefore = address(engine).balance;
        uint256 available = balanceBefore > FUEL ? balanceBefore - FUEL : 0;
        (, uint256 previewSpend) = engine.previewBuyback();
        uint256 burned = _buyback();
        uint256 spent = balanceBefore - address(engine).balance;

        assertEq(spent, previewSpend, "preview and execution agree");
        assertLe(spent, available, "never past the revenue above the fuel reserve");
        assertGe(address(engine).balance, balanceBefore < FUEL ? balanceBefore : FUEL, "fuel is never spent");
        assertLe(spent, rHbar * impactBps / (10_000 - impactBps), "never past the impact cap");
        assertLe(spent * hbarPrice / 1e8, budgetUsd, "never past the daily budget");
        assertLe(engine.spentTodayUsd(), budgetUsd);
        if (spent == 0) {
            assertEq(burned, 0);
        } else {
            assertGe(spent, MIN_SPEND);
            assertGt(burned, 0);
            (uint256 h, uint256 t) = _reserves();
            if (ceiling != 0) assertLe(h * hbarPrice, ceiling * t, "pool price ends at or below the ceiling");
        }
        assertEq(furn.balanceOf(address(engine)), engine.teamUnclaimed() + engine.liquidityUnseeded());
    }
}

interface MockPairLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function setReserves(uint112 r0, uint112 r1) external;
}

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
}

/// Every buyback test again with WHBAR sorting above the token, so the pair is (token, WHBAR) and the engine has to
/// read its reserves in the other order.
contract FurnaceReversedOrderTest is FurnaceBuybackTest {
    function whbarAddr() internal pure override returns (address) {
        return address(type(uint160).max);
    }

    function test_poolOrder_tokenIsToken0WhenWhbarSortsAbove() public view {
        assertEq(pool.token0(), address(furn));
        assertEq(pool.token1(), whbarAddr());
    }
}
