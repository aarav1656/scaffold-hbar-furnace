// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// forge-lint: disable-start(unsafe-typecast)

import { Vm } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockV1Pair } from "./mocks/MockSaucerSwapV1.sol";
import { FurnaceBase } from "./FurnaceBase.sol";

contract FurnaceSetupTest is FurnaceBase {
    // ---------------------------------------------------------------- constructor

    function test_constructor_readsFactoryAndWhbarFromTheRouter() public view {
        assertEq(address(engine.router()), address(router));
        assertEq(address(engine.factory()), address(factory));
        assertEq(engine.whbar(), whbarAddr());
        assertEq(engine.owner(), owner);
        assertEq(engine.fuelReserve(), FUEL);
        assertEq(engine.minSpend(), MIN_SPEND);
        assertEq(engine.dailyBudgetUsd(), DAILY_BUDGET_USD);
        assertEq(engine.maxImpactBps(), MAX_IMPACT_BPS);
        assertEq(engine.slippageBps(), SLIPPAGE_BPS);
    }

    function test_constructor_rejectsBadConfig() public {
        FurnaceEngine.Config memory c = _config();
        c.router = address(0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.hbarUsdFeed = address(0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.minSpend = 0;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.scheduledGas = 2_999_999;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.maxImpactBps = 0;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.maxImpactBps = 1001;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.slippageBps = 1001;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);

        c = _config();
        c.priceCeilingUsd = uint256(type(uint64).max) + 1;
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        new FurnaceEngine(c);
    }

    function test_constructor_acceptsTheBounds() public {
        FurnaceEngine.Config memory c = _config();
        c.scheduledGas = 3_000_000;
        c.maxImpactBps = 1000;
        c.slippageBps = 1000;
        c.priceCeilingUsd = type(uint64).max;
        FurnaceEngine e = _deployEngine(c);
        assertEq(e.maxImpactBps(), 1000);
    }

    // ---------------------------------------------------------------- initialize

    function test_initialize_createsAFiniteTokenTheEngineTreasuresAndMints() public {
        _initialize();

        assertEq(hts.createCount(), 1);
        assertEq(engine.token(), hts.lastCreated());
        assertTrue(hts.lastFiniteSupply(), "supply type is FINITE");
        assertEq(hts.lastMaxSupply(), int64(uint64(TOTAL_SUPPLY)), "max supply equals total supply");
        assertEq(hts.lastInitialSupply(), int64(uint64(TOTAL_SUPPLY)));
        assertEq(hts.lastTreasury(), address(engine));
        assertEq(hts.lastAutoRenewAccount(), address(engine));

        assertEq(furn.totalSupply(), TOTAL_SUPPLY);
        assertEq(furn.balanceOf(address(engine)), TOTAL_SUPPLY, "the engine is the treasury and holds it all");
        assertEq(furn.maxSupply(), TOTAL_SUPPLY);
        assertEq(furn.decimals(), DECIMALS);
        assertEq(furn.name(), "Furnace Demo");
        assertEq(furn.symbol(), "FURN");
        assertEq(engine.tokenDecimals(), DECIMALS);
    }

    function test_initialize_holdsTheOnlyKeyAndItIsTheSupplyKey() public {
        _initialize();
        assertEq(hts.lastKeyCount(), 1, "no admin, wipe, freeze, pause or KYC key");
        assertEq(hts.lastKeyType(), 16, "the one key is the supply key");
        assertEq(hts.supplyKeyHolder(engine.token()), address(engine));
    }

    function test_initialize_splitsTheSupplyIntoLiquidityAndTeamAllocations() public {
        _initialize();
        assertEq(engine.liquidityUnseeded(), LIQUIDITY);
        assertEq(engine.teamUnclaimed(), TEAM);
        assertEq(engine.liquidityUnseeded() + engine.teamUnclaimed(), TOTAL_SUPPLY);
    }

    function test_initialize_leavesWhatTheHtsFeeDoesNotTakeInTheEngine() public {
        vm.recordLogs();
        _initialize();
        assertEq(address(engine).balance, INIT_VALUE - CREATE_FEE);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countOf(logs, FurnaceEngine.Initialized.selector), 1);
    }

    function test_initialize_emitsInitialized() public {
        vm.deal(owner, INIT_VALUE);
        vm.expectEmit(false, false, false, true, address(engine));
        emit FurnaceEngine.Initialized(address(0), TOTAL_SUPPLY, LIQUIDITY);
        vm.prank(owner);
        engine.initialize{ value: INIT_VALUE }(
            "Furnace Demo", "FURN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY)
        );
    }

    function test_initialize_allowsAllSupplyToTheLiquidityPool() public {
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        engine.initialize{ value: INIT_VALUE }("All", "ALL", uint64(TOTAL_SUPPLY), DECIMALS, uint64(TOTAL_SUPPLY));
        assertEq(engine.teamUnclaimed(), 0);
        assertEq(engine.liquidityUnseeded(), TOTAL_SUPPLY);
    }

    function test_initialize_isOwnerOnly() public {
        vm.deal(alice, INIT_VALUE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.initialize{ value: INIT_VALUE }(
            "Furnace Demo", "FURN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY)
        );
        assertEq(engine.token(), address(0));
        assertEq(hts.createCount(), 0);
    }

    function test_initialize_runsOnce() public {
        _initialize();
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.AlreadyInitialized.selector);
        engine.initialize{ value: INIT_VALUE }("Again", "AGN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY));
        assertEq(hts.createCount(), 1);
    }

    function test_initialize_rejectsBadSupplyShapes() public {
        vm.deal(owner, 10 * INIT_VALUE);
        vm.startPrank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.initialize{ value: INIT_VALUE }("X", "X", 0, DECIMALS, 0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.initialize{ value: INIT_VALUE }("X", "X", uint64(TOTAL_SUPPLY), DECIMALS, 0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.initialize{ value: INIT_VALUE }("X", "X", uint64(TOTAL_SUPPLY), DECIMALS, uint64(TOTAL_SUPPLY) + 1);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.initialize{ value: INIT_VALUE }("X", "X", uint64(type(int64).max) + 1, DECIMALS, 1);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.initialize{ value: INIT_VALUE }("X", "X", uint64(TOTAL_SUPPLY), 19, uint64(LIQUIDITY));
        vm.stopPrank();
        assertEq(hts.createCount(), 0);
    }

    function test_initialize_acceptsTheLargestHtsSupplyAndEighteenDecimals() public {
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        engine.initialize{ value: INIT_VALUE }("Max", "MAX", uint64(type(int64).max), 18, 1);
        assertEq(IERC20Like(engine.token()).totalSupply(), uint256(uint64(type(int64).max)));
    }

    function test_initialize_revertsWhenHtsRefusesAndStoresNothing() public {
        hts.setForcedCodes(177, 0, 0);
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.HtsCallFailed.selector, int64(177)));
        engine.initialize{ value: INIT_VALUE }(
            "Furnace Demo", "FURN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY)
        );
        assertEq(engine.token(), address(0));
        assertEq(engine.teamUnclaimed(), 0);
    }

    function test_initialize_revertsWhenTheFeeIsNotCovered() public {
        vm.deal(owner, CREATE_FEE);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.HtsCallFailed.selector, int64(9)));
        engine.initialize{ value: CREATE_FEE - 1 }(
            "Furnace Demo", "FURN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY)
        );
    }

    // ---------------------------------------------------------------- createPool

    function test_poolCreationFee_isThePairTinycentFeeAtTheCurrentRate() public {
        uint256 expected = factory.pairCreateFee() * TINYBAR_PER_CENT / 1e8;
        assertEq(engine.poolCreationFee(), expected);
        assertEq(expected, 1_975_575_200, "$2.00 of HBAR at the rate read in the spike");

        fx.setTinybarPerCent(2 * TINYBAR_PER_CENT);
        assertEq(engine.poolCreationFee(), 2 * expected, "the fee follows the exchange rate");
    }

    function test_createPool_createsThePairAndAssociatesTheLpToken() public {
        _initialize();
        uint256 fee = engine.poolCreationFee();
        vm.deal(owner, fee);
        vm.expectEmit(false, false, false, false, address(engine));
        emit FurnaceEngine.PoolCreated(address(0), address(0), fee);
        vm.prank(owner);
        engine.createPool{ value: fee }();

        assertEq(engine.pair(), factory.getPair(address(furn), whbarAddr()));
        MockV1Pair p = MockV1Pair(engine.pair());
        assertEq(engine.lpToken(), p.lpToken());
        assertTrue(MockHtsToken(engine.lpToken()).associated(address(engine)), "engine can receive LP tokens");
        assertEq(factory.lastFeePaid(), fee, "the exchange-rate converted fee went to the factory");
    }

    function test_createPool_keepsAnyExcessAsRevenue() public {
        _initialize();
        uint256 fee = engine.poolCreationFee();
        uint256 before = address(engine).balance;
        vm.deal(owner, fee + 5e8);
        vm.prank(owner);
        engine.createPool{ value: fee + 5e8 }();
        assertEq(address(engine).balance, before + 5e8);
        assertEq(factory.lastFeePaid(), fee, "only the fee is sent to the factory");
    }

    function test_createPool_rejectsAFeeBelowTheConvertedAmount() public {
        _initialize();
        uint256 fee = engine.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FurnaceEngine.InsufficientFee.selector, fee, fee - 1));
        engine.createPool{ value: fee - 1 }();
        assertEq(engine.pair(), address(0));
    }

    function test_createPool_isOwnerOnly() public {
        _initialize();
        uint256 fee = engine.poolCreationFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.createPool{ value: fee }();
    }

    function test_createPool_needsTheTokenFirst() public {
        uint256 fee = engine.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.NotInitialized.selector);
        engine.createPool{ value: fee }();
    }

    function test_createPool_runsOnce() public {
        _initialize();
        _createPool();
        uint256 fee = engine.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.PoolExists.selector);
        engine.createPool{ value: fee }();
    }

    function test_createPool_recordsTheSortedOrderOfTheTokens() public {
        _initialize();
        _createPool();
        assertEq(pool.token0(), whbarAddr(), "WHBAR sorts below the new token");
        assertEq(pool.token1(), address(furn));
    }

    // ---------------------------------------------------------------- seedLiquidity

    function test_seedLiquidity_depositsTheAllocationAndKeepsTheLpTokens() public {
        _initialize();
        _createPool();
        _seed(SEED_HBAR);

        (uint256 rHbar, uint256 rToken) = _reserves();
        assertEq(rHbar, SEED_HBAR);
        assertEq(rToken, LIQUIDITY);
        assertEq(engine.liquidityUnseeded(), 0);
        assertEq(furn.balanceOf(address(engine)), TEAM, "only the team allocation is left in the treasury");
        assertEq(furn.balanceOf(address(pool)), LIQUIDITY);

        uint256 minted = Math.sqrt(SEED_HBAR * LIQUIDITY);
        assertEq(lp.balanceOf(address(engine)), minted, "the engine holds every LP token");
        assertEq(lp.totalSupply(), minted);
        assertEq(address(engine).balance, INIT_VALUE - CREATE_FEE, "the HBAR sent went into the pool");
    }

    function test_seedLiquidity_emitsWhatWasDeposited() public {
        _initialize();
        _createPool();
        vm.deal(owner, SEED_HBAR);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.LiquiditySeeded(LIQUIDITY, SEED_HBAR, Math.sqrt(SEED_HBAR * LIQUIDITY));
        vm.prank(owner);
        engine.seedLiquidity{ value: SEED_HBAR }(0, 0);
    }

    function test_seedLiquidity_isOwnerOnly() public {
        _initialize();
        _createPool();
        vm.deal(alice, SEED_HBAR);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.seedLiquidity{ value: SEED_HBAR }(0, 0);
    }

    function test_seedLiquidity_needsAPoolAndHbar() public {
        _initialize();
        vm.deal(owner, SEED_HBAR);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.PoolMissing.selector);
        engine.seedLiquidity{ value: SEED_HBAR }(0, 0);

        _createPool();
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.ZeroAmount.selector);
        engine.seedLiquidity{ value: 0 }(0, 0);
    }

    function test_seedLiquidity_refusesToSeedTwice() public {
        _ready();
        vm.deal(owner, SEED_HBAR);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.AlreadySeeded.selector);
        engine.seedLiquidity{ value: SEED_HBAR }(0, 0);
    }

    function test_seedLiquidity_passesTheMinimumsToTheRouter() public {
        _initialize();
        _createPool();
        vm.deal(owner, SEED_HBAR);
        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_AMOUNT");
        engine.seedLiquidity{ value: SEED_HBAR }(LIQUIDITY + 1, 0);

        vm.prank(owner);
        vm.expectRevert("INSUFFICIENT_AMOUNT");
        engine.seedLiquidity{ value: SEED_HBAR }(0, SEED_HBAR + 1);
        assertEq(engine.liquidityUnseeded(), LIQUIDITY, "a refused seed changes nothing");
    }

    function test_seedLiquidity_refundsHbarThePoolRatioDoesNotTake() public {
        _initialize();
        _createPool();
        _setPoolReserves(1000e8, LIQUIDITY);
        uint256 before = address(engine).balance;
        _seed(1500e8);
        (uint256 rHbar,) = _reserves();
        assertEq(rHbar, 2000e8, "only 1000 HBAR matches the pool ratio");
        assertEq(address(engine).balance, before + 500e8, "the surplus is back in the engine as revenue");
        assertEq(engine.liquidityUnseeded(), 0);
    }

    function test_seedLiquidity_canFinishALeftoverAllocation() public {
        _initialize();
        _createPool();
        _setPoolReserves(1000e8, 100_000e8);
        _seed(1000e8);
        assertEq(engine.liquidityUnseeded(), 300_000e8, "the router took only the tokens the ratio needs");

        _seed(3000e8);
        assertEq(engine.liquidityUnseeded(), 0);
        assertEq(furn.balanceOf(address(engine)), TEAM);
    }

    function test_lpTokens_neverLeaveTheEngine() public {
        _ready();
        uint256 minted = lp.balanceOf(address(engine));
        assertGt(minted, 0);

        _revenue(200e8);
        _buyback();
        vm.prank(owner);
        engine.setDailyBudgetUsd(5e8);
        vm.prank(owner);
        engine.startAutomation(1 hours);
        vm.prank(owner);
        engine.stopAutomation();
        address friend = makeAddr("friend");
        vm.prank(friend);
        furn.associate();
        vm.prank(owner);
        engine.claimTeamAllocation(friend);

        assertEq(lp.balanceOf(address(engine)), minted, "no call changed the LP balance");
        assertEq(lp.allowance(address(engine), owner), 0);
        assertEq(lp.allowance(address(engine), address(router)), 0, "the engine never approves its LP token");
    }

    // ---------------------------------------------------------------- claimTeamAllocation

    function test_claim_paysTheAssociatedRecipientTheWholeTeamAllocation() public {
        _ready();
        address team = makeAddr("team");
        vm.prank(team);
        furn.associate();

        vm.expectEmit(address(engine));
        emit FurnaceEngine.TeamAllocationClaimed(team, TEAM);
        vm.prank(owner);
        engine.claimTeamAllocation(team);

        assertEq(furn.balanceOf(team), TEAM);
        assertEq(furn.balanceOf(address(engine)), 0);
        assertEq(engine.teamUnclaimed(), 0);
        assertEq(furn.totalSupply(), TOTAL_SUPPLY, "claiming moves tokens, it does not mint or burn");
    }

    function test_claim_failsForAnUnassociatedRecipientAndKeepsTheAllocation() public {
        _ready();
        address team = makeAddr("team");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockHtsToken.TokenNotAssociatedToAccount.selector, team));
        engine.claimTeamAllocation(team);
        assertEq(engine.teamUnclaimed(), TEAM, "a failed claim leaves the allocation claimable");
        assertEq(furn.balanceOf(address(engine)), TEAM);
    }

    function test_claim_isOwnerOnlyAndRejectsZeroAddressAndRepeats() public {
        _ready();
        address team = makeAddr("team");
        vm.prank(team);
        furn.associate();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.claimTeamAllocation(team);

        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.ZeroAddress.selector);
        engine.claimTeamAllocation(address(0));

        vm.prank(owner);
        engine.claimTeamAllocation(team);
        vm.prank(owner);
        vm.expectRevert(FurnaceEngine.ZeroAmount.selector);
        engine.claimTeamAllocation(team);
    }

    // ---------------------------------------------------------------- policy setters

    function test_setters_areOwnerOnly() public {
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(denied);
        engine.setDailyBudgetUsd(1);
        vm.expectRevert(denied);
        engine.setMaxImpactBps(1);
        vm.expectRevert(denied);
        engine.setPriceCeilingUsd(1);
        vm.expectRevert(denied);
        engine.setSlippageBps(1);
        vm.stopPrank();
    }

    function test_setters_updateAndEmit() public {
        vm.startPrank(owner);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.DailyBudgetSet(7e8);
        engine.setDailyBudgetUsd(7e8);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.MaxImpactSet(250);
        engine.setMaxImpactBps(250);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.PriceCeilingSet(123_456);
        engine.setPriceCeilingUsd(123_456);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.SlippageSet(42);
        engine.setSlippageBps(42);
        vm.stopPrank();

        assertEq(engine.dailyBudgetUsd(), 7e8);
        assertEq(engine.maxImpactBps(), 250);
        assertEq(engine.priceCeilingUsd(), 123_456);
        assertEq(engine.slippageBps(), 42);
    }

    function test_setters_enforceTheirBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxImpactBps(0);
        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setMaxImpactBps(1001);
        engine.setMaxImpactBps(1000);

        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setSlippageBps(1001);
        engine.setSlippageBps(1000);
        engine.setSlippageBps(0);

        vm.expectRevert(FurnaceEngine.BadConfig.selector);
        engine.setPriceCeilingUsd(uint256(type(uint64).max) + 1);
        engine.setPriceCeilingUsd(type(uint64).max);
        engine.setPriceCeilingUsd(0);

        engine.setDailyBudgetUsd(0);
        engine.setDailyBudgetUsd(type(uint128).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- revenue

    function test_receive_acceptsRevenueAndSaysSo() public {
        vm.deal(alice, 5e8);
        vm.expectEmit(address(engine));
        emit FurnaceEngine.RevenueReceived(alice, 5e8);
        vm.prank(alice);
        (bool ok,) = address(engine).call{ value: 5e8 }("");
        assertTrue(ok);
        assertEq(address(engine).balance, 5e8);
    }

    /// The engine's whole state-changing surface, read from the compiled ABI. Anything that could move HBAR, LP
    /// tokens or bought tokens to an outsider would have to appear here, so adding a function fails this test until
    /// the list (and the claim in the README) is revisited on purpose.
    function test_stateChangingSurface_isExactlyTheReviewedList() public view {
        string memory abiJson = vm.readFile("out/FurnaceEngine.sol/FurnaceEngine.json");
        string[] memory names = abi.decode(
            vm.parseJson(
                abiJson, '$.abi[?(@.type=="function" && @.stateMutability!="view" && @.stateMutability!="pure")].name'
            ),
            (string[])
        );
        string[19] memory expected = [
            "buyback",
            "claimTeamAllocation",
            "createPool",
            "depositRevenue",
            "initialize",
            "rearm",
            "renounceOwnership",
            "runScheduled",
            "seedLiquidity",
            "setDailyBudgetUsd",
            "setMaxImpactBps",
            "setMaxLotUsd",
            "setMaxTwapDeviationBps",
            "setMinGapSeconds",
            "setPriceCeilingUsd",
            "setSlippageBps",
            "startAutomation",
            "stopAutomation",
            "transferOwnership"
        ];
        assertEq(names.length, 19, "a new state-changing function needs a security review");
        for (uint256 i; i < names.length; ++i) {
            bool known;
            for (uint256 j; j < 19; ++j) {
                if (keccak256(bytes(names[i])) == keccak256(bytes(expected[j]))) known = true;
            }
            assertTrue(known, names[i]);
        }
    }

    function test_noEntryPointSendsHbarToTheCaller() public {
        _ready();
        _revenue(100e8);
        address friend = makeAddr("friend");
        vm.prank(friend);
        furn.associate();
        uint256 ownerBefore = owner.balance;
        vm.startPrank(owner);
        engine.setDailyBudgetUsd(50e8);
        engine.buyback();
        engine.claimTeamAllocation(friend);
        engine.startAutomation(1 hours);
        engine.stopAutomation();
        vm.stopPrank();
        assertEq(owner.balance, ownerBefore, "the owner never receives HBAR from the engine");
        assertEq(friend.balance, 0);
    }
}

interface IERC20Like {
    function totalSupply() external view returns (uint256);
}
