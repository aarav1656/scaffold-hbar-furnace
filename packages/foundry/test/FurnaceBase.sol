// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test, Vm } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { FurnaceEngine } from "../contracts/FurnaceEngine.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockShareToken, MockHts, MockHss } from "./mocks/MockHederaSystem.sol";
import {
    MockExchangeRate, MockV1Factory, MockV1Router, MockV1Pair, MockAggregator
} from "./mocks/MockSaucerSwapV1.sol";

/// Fixture for every FurnaceEngine test: Hedera system contracts etched at 0x167, 0x168 and 0x16b, a SaucerSwap V1
/// factory and router that trade constant product at the 0.3% fee in tinybar, and a Chainlink feed. The token the engine
/// creates sorts above WHBAR, so the pair has WHBAR as token0; `FurnaceReversedOrderTest` flips that.
abstract contract FurnaceBase is Test {
    address internal constant HTS_ADDR = address(0x167);
    address internal constant FX_ADDR = address(0x168);
    address internal constant HSS_ADDR = address(0x16b);

    uint256 internal constant T0 = 1_700_000_000;
    /// HBAR at 0.20 USD, 8 decimals.
    int256 internal constant HBAR_USD = 20_000_000;
    uint256 internal constant HBAR_USD_U = 20_000_000;
    uint256 internal constant MAX_ORACLE_AGE = 26 hours;
    uint256 internal constant SCHEDULED_GAS = 3_000_000;
    uint256 internal constant TINYBAR = 1e8;
    /// HBAR the HTS mock keeps for creating the token, and what initialize is sent (the rest is left in the engine).
    uint256 internal constant CREATE_FEE = 12e8;
    uint256 internal constant INIT_VALUE = 20e8;
    /// 9.877876 million tinybar per cent, as the live exchange rate read in the spike.
    uint256 internal constant TINYBAR_PER_CENT = 9_877_876;

    uint256 internal constant TOTAL_SUPPLY = 1_000_000e8;
    uint256 internal constant LIQUIDITY = 400_000e8;
    uint256 internal constant TEAM = 600_000e8;
    uint8 internal constant DECIMALS = 8;
    /// Pool seeded with 1000 HBAR against 400,000 tokens: 0.0025 HBAR per token, $0.0005 at $0.20 per HBAR.
    uint256 internal constant SEED_HBAR = 1000e8;

    uint256 internal constant FUEL = 10e8;
    uint256 internal constant MIN_SPEND = 1e8;
    /// $100 a day is 500 HBAR at $0.20.
    uint256 internal constant DAILY_BUDGET_USD = 100e8;
    uint256 internal constant MAX_IMPACT_BPS = 500;
    uint256 internal constant SLIPPAGE_BPS = 100;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    MockHts internal hts = MockHts(HTS_ADDR);
    MockHss internal hss = MockHss(HSS_ADDR);
    MockExchangeRate internal fx = MockExchangeRate(FX_ADDR);
    MockV1Factory internal factory;
    MockV1Router internal router;
    MockAggregator internal feed;
    MockHtsToken internal whbarToken;

    FurnaceEngine internal engine;
    MockShareToken internal furn;
    MockV1Pair internal pool;
    MockHtsToken internal lp;

    /// WHBAR's address decides the pair ordering: below the created token's address it is token0.
    function whbarAddr() internal view virtual returns (address) {
        return address(0x3ad2);
    }

    function setUp() public virtual {
        vm.warp(T0);
        vm.etch(HTS_ADDR, address(new MockHts()).code);
        vm.etch(HSS_ADDR, address(new MockHss()).code);
        vm.etch(FX_ADDR, address(new MockExchangeRate()).code);
        hts.setCreateFee(CREATE_FEE);
        fx.setTinybarPerCent(TINYBAR_PER_CENT);

        deployCodeTo("MockHtsToken.sol:MockHtsToken", abi.encode("Wrapped HBAR", "WHBAR", uint8(8)), whbarAddr());
        whbarToken = MockHtsToken(whbarAddr());
        factory = new MockV1Factory();
        router = new MockV1Router(factory, whbarAddr());
        factory.setRouter(address(router));
        feed = new MockAggregator();
        feed.set(HBAR_USD, T0);

        engine = _deployEngine(_config());
    }

    // ------------------------------------------------------------ builders

    function _config() internal view returns (FurnaceEngine.Config memory) {
        return FurnaceEngine.Config({
            router: address(router),
            hbarUsdFeed: address(feed),
            maxOracleAge: MAX_ORACLE_AGE,
            fuelReserve: FUEL,
            minSpend: MIN_SPEND,
            scheduledGas: SCHEDULED_GAS,
            dailyBudgetUsd: DAILY_BUDGET_USD,
            maxImpactBps: MAX_IMPACT_BPS,
            priceCeilingUsd: 0,
            slippageBps: SLIPPAGE_BPS
        });
    }

    function _deployEngine(FurnaceEngine.Config memory config) internal returns (FurnaceEngine e) {
        vm.prank(owner);
        e = new FurnaceEngine(config);
    }

    function _initialize() internal {
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        engine.initialize{ value: INIT_VALUE }("Furnace Demo", "FURN", uint64(TOTAL_SUPPLY), DECIMALS, uint64(LIQUIDITY));
        furn = MockShareToken(engine.token());
    }

    function _createPool() internal {
        uint256 fee = engine.poolCreationFee();
        vm.deal(owner, fee);
        vm.prank(owner);
        engine.createPool{ value: fee }();
        pool = MockV1Pair(engine.pair());
        lp = MockHtsToken(engine.lpToken());
    }

    function _seed(uint256 hbar) internal {
        vm.deal(owner, hbar);
        vm.prank(owner);
        engine.seedLiquidity{ value: hbar }(0, 0);
    }

    /// Initialised, paired and seeded: the state every buyback test starts from.
    function _ready() internal {
        _initialize();
        _createPool();
        _seed(SEED_HBAR);
    }

    /// Moves the market without trading, as another trader would: sets the pair's reserves in its own order.
    function _setPoolReserves(uint256 rHbar, uint256 rToken) internal {
        // forge-lint: disable-next-line(unsafe-typecast)
        (uint112 h, uint112 t) = (uint112(rHbar), uint112(rToken));
        if (pool.token0() == address(furn)) pool.setReserves(t, h);
        else pool.setReserves(h, t);
    }

    /// Pays revenue into the engine from an outside account.
    function _revenue(uint256 amount) internal {
        vm.deal(alice, amount);
        vm.prank(alice);
        (bool ok,) = address(engine).call{ value: amount }("");
        assertTrue(ok);
    }

    function _buyback() internal returns (uint256 burned) {
        vm.prank(owner);
        burned = engine.buyback();
    }

    // ------------------------------------------------------------ reads

    function _reserves() internal view returns (uint256 rHbar, uint256 rToken) {
        (uint256 r0, uint256 r1,) = pool.getReserves();
        return pool.token0() == address(furn) ? (r1, r0) : (r0, r1);
    }

    /// The pool's spot price in USD (8 decimals per whole token), at the fixture's HBAR price.
    function _spotUsd() internal view returns (uint256) {
        (uint256 rHbar, uint256 rToken) = _reserves();
        return rHbar * 10 ** DECIMALS * HBAR_USD_U / (rToken * TINYBAR);
    }

    /// Price impact of spending `x` into reserves `r` as Uniswap UIs define it, in basis points (ignores the fee).
    function _impactBps(uint256 x, uint256 r) internal pure returns (uint256) {
        return x * 10_000 / (r + x);
    }

    /// Plays the network's part: warps to a recorded schedule's second, optionally keeps the oracle fresh, and runs the
    /// call as the scheduling contract with the gas it was booked with.
    function _runSchedule(uint256 index, bool refreshOracle) internal returns (bool ok, bytes memory ret) {
        MockHss.ScheduledCall memory c = hss.callAt(index);
        vm.warp(c.expirySecond);
        if (refreshOracle) feed.set(HBAR_USD, block.timestamp);
        vm.prank(c.to);
        (ok, ret) = c.to.call{ gas: c.gasLimit }(c.callData);
    }

    /// Index of the first log in `logs` whose first topic is `sig`, or type(uint256).max.
    function _indexOf(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) return i;
        }
        return type(uint256).max;
    }

    function _countOf(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) ++n;
        }
    }
}
