// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IHRC719 } from "./interfaces/IHRC719.sol";
import { IExchangeRate } from "./interfaces/IExchangeRate.sol";
import { ISaucerSwapV1Factory, ISaucerSwapV1Pair, ISaucerSwapV1Router } from "./interfaces/ISaucerSwapV1.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";

/// @title FurnaceEngine
/// @notice A token team's buyback-and-burn engine on Hedera. The engine creates the team's HTS token with itself as
/// treasury and sole supply-key holder, pairs it with WHBAR on SaucerSwap V1 and locks the liquidity for good. HBAR
/// sent to it is protocol revenue: on its own Hedera Schedule Service schedule the engine spends it buying the token
/// back, within a daily USD budget priced by Chainlink, never past a USD price ceiling and never moving the pool by
/// more than a set price impact, then burns what it bought. Supply is enforced by the network, so the burn is
/// verifiable on any mirror node.
/// @dev The owner has no function that moves HBAR, LP tokens or bought tokens out of the engine. HBAR leaves only
/// through the HTS and pair creation fees, the router and the gas of the engine's own schedules.
contract FurnaceEngine is Ownable, ReentrancyGuard {
    /// @notice Why a buyback run spent nothing. `None` means it would spend.
    enum Skip {
        None,
        NotReady,
        NoFunds,
        BudgetSpent,
        PriceCeiling,
        ImpactCap
    }

    /// @notice What `buyback()` would do right now.
    struct Plan {
        Skip skip;
        uint256 spend;
        uint256 hbarUsd;
        uint256 reserveHbar;
        uint256 reserveToken;
    }

    struct Config {
        address router;
        address hbarUsdFeed;
        uint256 maxOracleAge;
        uint256 fuelReserve;
        uint256 minSpend;
        uint256 scheduledGas;
        uint256 dailyBudgetUsd;
        uint256 maxImpactBps;
        uint256 priceCeilingUsd;
        uint256 slippageBps;
    }

    struct Status {
        address token;
        address pair;
        address lpToken;
        uint256 totalSupply;
        uint256 totalBurned;
        uint256 totalSpentHbar;
        uint256 spentTodayUsd;
        uint256 budgetLeftUsd;
        uint256 priceHbar;
        uint256 priceUsd;
        uint256 hbarUsd;
        uint256 reserveHbar;
        uint256 reserveToken;
        uint256 teamUnclaimed;
        uint256 liquidityUnseeded;
        uint256 balance;
        uint256 fuel;
        uint256 nextRunAt;
        address pendingSchedule;
        uint256 interval;
    }

    IHederaTokenService private constant HTS = IHederaTokenService(address(0x167));
    IHederaScheduleService private constant HSS = IHederaScheduleService(address(0x16b));
    IExchangeRate private constant EXCHANGE_RATE = IExchangeRate(address(0x168));
    int64 private constant SUCCESS = 22;
    int64 private constant TOKEN_ALREADY_ASSOCIATED = 194;
    uint256 private constant SUPPLY_KEY = 16;
    uint256 private constant BPS = 10_000;
    uint256 private constant TINYBAR_PER_HBAR = 1e8;
    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_DECIMALS = 18;
    uint256 private constant BUDGET_WINDOW = 1 days;
    /// Seconds past the ideal expiry to probe for a free slot: 1, 2, 4, 8, 16.
    uint256 private constant MAX_CAPACITY_DELAY = 16;

    /// @notice Highest price impact a single buyback may be configured to cause, in basis points.
    uint256 public constant MAX_IMPACT_BPS = 1000;
    /// @notice Highest slippage tolerance the owner may set, in basis points.
    uint256 public constant MAX_SLIPPAGE_BPS = 1000;
    /// @notice Shortest and longest gap between scheduled runs. Hedera refuses expiries past 62 days.
    uint256 public constant MIN_INTERVAL = 60;
    uint256 public constant MAX_INTERVAL = 60 days;
    /// @notice A self-rescheduling call under 3M gas runs once, fails to book its successor and still reports
    /// SUCCESS. Measured on testnet.
    uint256 public constant MIN_SCHEDULED_GAS = 3_000_000;

    ISaucerSwapV1Router public immutable router;
    ISaucerSwapV1Factory public immutable factory;
    /// @notice The WHBAR HTS token the router pairs against.
    address public immutable whbar;
    AggregatorV3Interface public immutable hbarUsdFeed;
    /// @notice A Chainlink answer older than this blocks buybacks.
    uint256 public immutable maxOracleAge;
    /// @notice Native HBAR (tinybar) that buybacks never touch. It pays for the engine's scheduled runs.
    uint256 public immutable fuelReserve;
    /// @notice Smallest buyback worth the gas, in tinybar. Anything below it is skipped.
    uint256 public immutable minSpend;
    /// @notice Gas each scheduled run is booked with.
    uint256 public immutable scheduledGas;

    /// @notice USD the engine may spend per 24 hours, 8 decimals.
    uint256 public dailyBudgetUsd;
    /// @notice Most one buyback may move the pool's price, in basis points of execution-price shortfall.
    uint256 public maxImpactBps;
    /// @notice The engine never buys the token above this USD price per whole token (8 decimals). 0 means no ceiling.
    uint256 public priceCeilingUsd;
    /// @notice Most a swap may return below the router's own quote, in basis points.
    uint256 public slippageBps;

    /// @notice The HTS token. The engine is its treasury and holds its supply key.
    address public token;
    uint8 public tokenDecimals;
    address public pair;
    /// @notice The pair's HTS LP token. The engine holds all of it and has no function that moves it.
    address public lpToken;
    bool private _tokenIsToken0;

    /// @notice Team allocation still held by the engine, claimable by the owner. Never burned.
    uint256 public teamUnclaimed;
    /// @notice Tokens reserved to seed the pool. Never burned.
    uint256 public liquidityUnseeded;
    uint256 public totalBurned;
    uint256 public totalSpentHbar;
    /// @notice Start of the current 24h budget window, and the USD spent inside it.
    uint256 public windowStart;
    uint256 public spentTodayUsd;

    /// @notice Seconds between scheduled runs; 0 while automation is off.
    uint256 public runInterval;
    /// @notice The schedule that will run the next buyback, or address(0).
    address public pendingSchedule;
    /// @notice Consensus second the pending schedule is booked for.
    uint256 public nextRunAt;

    event Initialized(address indexed token, uint256 totalSupply, uint256 liquidityAllocation);
    event PoolCreated(address indexed pair, address indexed lpToken, uint256 feeTinybar);
    event LiquiditySeeded(uint256 tokenAmount, uint256 hbarAmount, uint256 lpMinted);
    event TeamAllocationClaimed(address indexed to, uint256 amount);
    event RevenueReceived(address indexed from, uint256 amount);
    event Burned(
        uint256 hbarIn,
        uint256 tokensBurned,
        uint256 priceHbar,
        uint256 priceUsd,
        uint256 supplyAfter
    );
    event BuybackSkipped(Skip reason);
    event DailyBudgetSet(uint256 dailyBudgetUsd);
    event MaxImpactSet(uint256 maxImpactBps);
    event PriceCeilingSet(uint256 priceCeilingUsd);
    event SlippageSet(uint256 slippageBps);
    event AutomationStarted(uint256 interval);
    event AutomationStopped();
    event RunBooked(address indexed schedule, uint256 expiry);
    event BookingFailed(int64 responseCode);
    event ScheduledRun(uint256 tokensBurned);
    event ScheduledRunFailed(bytes reason);

    error AlreadyInitialized();
    error NotInitialized();
    error PoolExists();
    error PoolMissing();
    error AlreadySeeded();
    error BadConfig();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientFee(uint256 required, uint256 sent);
    error StaleOracle(uint256 updatedAt);
    error BadOraclePrice(int256 answer);
    error HtsCallFailed(int64 responseCode);
    error TransferFailed(address token);
    error NothingBought();
    error AllocationBreach();
    error NotOwnerOrSelf();
    error OnlySelf();
    error AutomationActive();
    error BadInterval(uint256 interval);
    error ScheduleFailed(int64 responseCode);

    modifier onlyOwnerOrSelf() {
        if (msg.sender != owner() && msg.sender != address(this)) revert NotOwnerOrSelf();
        _;
    }

    constructor(Config memory config) Ownable(msg.sender) {
        if (
            config.router == address(0) || config.hbarUsdFeed == address(0) || config.minSpend == 0
                || config.scheduledGas < MIN_SCHEDULED_GAS
        ) revert BadConfig();
        _checkPolicy(config.maxImpactBps, config.priceCeilingUsd, config.slippageBps);

        router = ISaucerSwapV1Router(config.router);
        factory = ISaucerSwapV1Factory(router.factory());
        whbar = router.whbar();
        hbarUsdFeed = AggregatorV3Interface(config.hbarUsdFeed);
        maxOracleAge = config.maxOracleAge;
        fuelReserve = config.fuelReserve;
        minSpend = config.minSpend;
        scheduledGas = config.scheduledGas;
        dailyBudgetUsd = config.dailyBudgetUsd;
        maxImpactBps = config.maxImpactBps;
        priceCeilingUsd = config.priceCeilingUsd;
        slippageBps = config.slippageBps;
    }

    /// @notice HBAR sent here is protocol revenue. Everything above `fuelReserve` is available to buybacks.
    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- setup

    /// @notice Creates the HTS token: finite supply, this engine as treasury and the only key (supply), no admin,
    /// wipe, freeze, pause or KYC key. `liquidityAllocation` is reserved for the pool and the rest of `totalSupply`
    /// is the team allocation. Send enough HBAR for the HTS creation fee; what it does not take stays in the engine.
    function initialize(
        string calldata name,
        string calldata symbol,
        uint64 totalSupply,
        uint8 decimals,
        uint64 liquidityAllocation
    ) external payable onlyOwner {
        if (token != address(0)) revert AlreadyInitialized();
        if (
            totalSupply == 0 || totalSupply > uint64(type(int64).max) || liquidityAllocation == 0
                || liquidityAllocation > totalSupply || decimals > MAX_DECIMALS
        ) revert BadConfig();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });
        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: name,
            symbol: symbol,
            treasury: address(this),
            memo: "Furnace buyback-and-burn token",
            tokenSupplyType: true,
            maxSupply: _int64(totalSupply),
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0, autoRenewAccount: address(this), autoRenewPeriod: 7_890_000
            })
        });
        (int64 rc, address created) =
            HTS.createFungibleToken{ value: msg.value }(spec, _int64(totalSupply), int32(uint32(decimals)));
        if (rc != SUCCESS) revert HtsCallFailed(rc);

        token = created;
        tokenDecimals = decimals;
        liquidityUnseeded = liquidityAllocation;
        teamUnclaimed = totalSupply - liquidityAllocation;
        emit Initialized(created, totalSupply, liquidityAllocation);
    }

    /// @notice What `createPool()` must be sent, in tinybar: SaucerSwap's tinycent fee converted at the current rate.
    function poolCreationFee() public view returns (uint256) {
        return EXCHANGE_RATE.tinycentsToTinybars(factory.pairCreateFee());
    }

    /// @notice Creates the token/WHBAR pair on SaucerSwap V1 and associates the engine with the pair's LP token.
    /// Send at least `poolCreationFee()`, and give the transaction 8M gas: the pair associates its tokens in the
    /// same call.
    function createPool() external payable onlyOwner {
        if (token == address(0)) revert NotInitialized();
        if (pair != address(0)) revert PoolExists();
        uint256 fee = poolCreationFee();
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        address created = factory.createPair{ value: fee }(token, whbar);
        address lp = ISaucerSwapV1Pair(created).lpToken();
        _associate(lp);
        pair = created;
        lpToken = lp;
        _tokenIsToken0 = ISaucerSwapV1Pair(created).token0() == token;
        emit PoolCreated(created, lp, fee);
    }

    /// @notice Seeds the pool with the liquidity allocation and the HBAR sent. The LP tokens stay in the engine
    /// for good: nothing in this contract can move them.
    /// @param minToken Reverts if the router would take fewer tokens than this.
    /// @param minHbar Reverts if the router would take less HBAR than this (tinybar).
    function seedLiquidity(uint256 minToken, uint256 minHbar) external payable onlyOwner {
        if (pair == address(0)) revert PoolMissing();
        uint256 want = liquidityUnseeded;
        if (want == 0) revert AlreadySeeded();
        if (msg.value == 0) revert ZeroAmount();

        if (!IERC20(token).approve(address(router), want)) revert TransferFailed(token);
        (uint256 usedToken, uint256 usedHbar, uint256 minted) = router.addLiquidityETH{ value: msg.value }(
            token, want, minToken, minHbar, address(this), block.timestamp + 300
        );
        liquidityUnseeded = want - usedToken;
        emit LiquiditySeeded(usedToken, usedHbar, minted);
    }

    /// @notice Sends the whole team allocation to `to`, which must already be associated with the token.
    function claimTeamAllocation(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = teamUnclaimed;
        if (amount == 0) revert ZeroAmount();
        teamUnclaimed = 0;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed(token);
        emit TeamAllocationClaimed(to, amount);
    }

    // ---------------------------------------------------------------- policy

    function setDailyBudgetUsd(uint256 value) external onlyOwner {
        dailyBudgetUsd = value;
        emit DailyBudgetSet(value);
    }

    function setMaxImpactBps(uint256 value) external onlyOwner {
        _checkPolicy(value, priceCeilingUsd, slippageBps);
        maxImpactBps = value;
        emit MaxImpactSet(value);
    }

    function setPriceCeilingUsd(uint256 value) external onlyOwner {
        _checkPolicy(maxImpactBps, value, slippageBps);
        priceCeilingUsd = value;
        emit PriceCeilingSet(value);
    }

    function setSlippageBps(uint256 value) external onlyOwner {
        _checkPolicy(maxImpactBps, priceCeilingUsd, value);
        slippageBps = value;
        emit SlippageSet(value);
    }

    // ---------------------------------------------------------------- buyback

    /// @notice Spends revenue buying the token back and burns what it bought. The owner may call it any time; the
    /// engine calls it on its own schedule. Hedera has no public mempool, so the exposure of a scheduled buy is its
    /// known time, which is why the price impact cap and the ceiling bound every run.
    /// @return tokensBurned The tokens bought and burned, 0 when the run was skipped.
    function buyback() public onlyOwnerOrSelf nonReentrant returns (uint256 tokensBurned) {
        Plan memory plan = _plan();
        if (plan.skip != Skip.None) {
            emit BuybackSkipped(plan.skip);
            return 0;
        }
        uint256 spend = plan.spend;

        // Effects first. The USD cost rounds up, so rounding can never let a day's spend pass the budget.
        if (block.timestamp >= windowStart + BUDGET_WINDOW) {
            windowStart = block.timestamp;
            spentTodayUsd = 0;
        }
        spentTodayUsd += Math.mulDiv(spend, plan.hbarUsd, TINYBAR_PER_HBAR, Math.Rounding.Ceil);
        totalSpentHbar += spend;

        address[] memory path = new address[](2);
        path[0] = whbar;
        path[1] = token;
        uint256 minOut = router.getAmountsOut(spend, path)[1] * (BPS - slippageBps) / BPS;
        uint256 held = IERC20(token).balanceOf(address(this));
        router.swapExactETHForTokens{ value: spend }(minOut, path, address(this), block.timestamp + 300);
        tokensBurned = IERC20(token).balanceOf(address(this)) - held;
        if (tokensBurned == 0) revert NothingBought();

        (int64 rc, int64 supplyAfter) = HTS.burnToken(token, _int64(tokensBurned), new int64[](0));
        if (rc != SUCCESS) revert HtsCallFailed(rc);
        totalBurned += tokensBurned;
        // Only tokens the swap just delivered were burned; the pool and team allocations are still all there.
        if (IERC20(token).balanceOf(address(this)) < teamUnclaimed + liquidityUnseeded) revert AllocationBreach();

        uint256 priceHbar = Math.mulDiv(spend, 10 ** tokenDecimals, tokensBurned);
        emit Burned(
            spend,
            tokensBurned,
            priceHbar,
            Math.mulDiv(priceHbar, plan.hbarUsd, TINYBAR_PER_HBAR),
            SafeCast.toUint256(int256(supplyAfter))
        );
    }

    /// @notice What `buyback()` would do now: the skip reason, or `None` and the tinybar it would spend.
    function previewBuyback() external view returns (Skip skip, uint256 spend) {
        Plan memory plan = _plan();
        return (plan.skip, plan.spend);
    }

    // ---------------------------------------------------------------- automation (HIP-1215)

    /// @notice Books a buyback every `interval` seconds, paid from the engine's native HBAR. Keep `fuelReserve`
    /// above `scheduledGas` times the network gas price: Hedera checks the payer against the gas reserved, not the
    /// gas burned.
    function startAutomation(uint256 interval) external onlyOwner {
        if (runInterval != 0) revert AutomationActive();
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert BadInterval(interval);
        runInterval = interval;
        int64 rc = _bookNext();
        if (rc != SUCCESS) revert ScheduleFailed(rc);
        emit AutomationStarted(interval);
    }

    /// @notice Stops automation and deletes the pending schedule.
    function stopAutomation() external onlyOwner {
        runInterval = 0;
        address pending = pendingSchedule;
        pendingSchedule = address(0);
        nextRunAt = 0;
        if (pending != address(0)) HSS.deleteSchedule(pending);
        emit AutomationStopped();
    }

    /// @notice Entry point for scheduled runs. Hedera executes a scheduled call with msg.sender set to the
    /// scheduling contract, so only the engine's own schedule can reach it.
    /// @dev Books the successor before buying and never reverts, so a failed buyback costs one run, not the chain.
    /// A scheduled execution may book exactly one schedule, so this is the only booking in the run.
    function runScheduled() external {
        if (msg.sender != address(this)) revert OnlySelf();
        pendingSchedule = address(0);
        nextRunAt = 0;
        if (runInterval == 0) return;
        // A lost booking ends the chain, so say so on chain: automation reads as off and can be restarted.
        if (_bookNext() != SUCCESS) runInterval = 0;
        try this.buyback() returns (uint256 burned) {
            emit ScheduledRun(burned);
        } catch (bytes memory reason) {
            emit ScheduledRunFailed(reason);
        }
    }

    // ---------------------------------------------------------------- views

    /// @notice Chainlink HBAR/USD with 8 decimals. Reverts if the answer is stale or not positive.
    function hbarUsd() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = hbarUsdFeed.latestRoundData();
        if (answer <= 0) revert BadOraclePrice(answer);
        if (block.timestamp > updatedAt + maxOracleAge) revert StaleOracle(updatedAt);
        return SafeCast.toUint256(answer);
    }

    /// @notice Everything a dashboard needs in one call. Never reverts: a stale oracle reads as zero USD figures.
    function status() external view returns (Status memory s) {
        s.token = token;
        s.pair = pair;
        s.lpToken = lpToken;
        s.totalSupply = token == address(0) ? 0 : IERC20(token).totalSupply();
        s.totalBurned = totalBurned;
        s.totalSpentHbar = totalSpentHbar;
        s.spentTodayUsd = _spentToday();
        s.budgetLeftUsd = dailyBudgetUsd > s.spentTodayUsd ? dailyBudgetUsd - s.spentTodayUsd : 0;
        s.teamUnclaimed = teamUnclaimed;
        s.liquidityUnseeded = liquidityUnseeded;
        s.balance = address(this).balance;
        s.fuel = fuelReserve;
        s.nextRunAt = nextRunAt;
        s.pendingSchedule = pendingSchedule;
        s.interval = runInterval;
        try this.hbarUsd() returns (uint256 usd) {
            s.hbarUsd = usd;
        } catch { }
        (s.reserveHbar, s.reserveToken) = _reserves();
        if (s.reserveToken != 0) {
            uint256 scaled = s.reserveHbar * 10 ** tokenDecimals;
            s.priceHbar = scaled / s.reserveToken;
            s.priceUsd = Math.mulDiv(scaled, s.hbarUsd, s.reserveToken * TINYBAR_PER_HBAR);
        }
    }

    // ---------------------------------------------------------------- internals

    /// The single place the buyback size is decided; `buyback()` and `previewBuyback()` both read it. Each cap is
    /// checked against `minSpend` in turn so a skip names the one that bound.
    function _plan() private view returns (Plan memory p) {
        (p.reserveHbar, p.reserveToken) = _reserves();
        if (p.reserveHbar == 0 || p.reserveToken == 0) {
            p.skip = Skip.NotReady;
            return p;
        }
        p.hbarUsd = hbarUsd();

        uint256 balance = address(this).balance;
        uint256 available = balance > fuelReserve ? balance - fuelReserve : 0;
        if (available < minSpend) {
            p.skip = Skip.NoFunds;
            return p;
        }

        uint256 spentToday = _spentToday();
        uint256 leftUsd = dailyBudgetUsd > spentToday ? dailyBudgetUsd - spentToday : 0;
        uint256 byBudget = Math.mulDiv(leftUsd, TINYBAR_PER_HBAR, p.hbarUsd);
        if (byBudget < minSpend) {
            p.skip = Skip.BudgetSpent;
            return p;
        }

        uint256 byCeiling = _ceilingHeadroom(p.reserveHbar, p.reserveToken, p.hbarUsd);
        if (byCeiling < minSpend) {
            p.skip = Skip.PriceCeiling;
            return p;
        }

        uint256 byImpact = p.reserveHbar * maxImpactBps / (BPS - maxImpactBps);
        if (byImpact < minSpend) {
            p.skip = Skip.ImpactCap;
            return p;
        }

        p.spend = Math.min(Math.min(available, byBudget), Math.min(byCeiling, byImpact));
    }

    /// Most HBAR (tinybar) that can go into the pool before its spot price passes `priceCeilingUsd`.
    /// Without a fee, buying x moves the price by (1 + x / R)^2, and the pool fee only lowers the real price, so
    /// solving (1 + x / R)^2 <= ceiling / price gives a bound the trade cannot cross. Every rounding floors.
    function _ceilingHeadroom(uint256 reserveHbar, uint256 reserveToken, uint256 usd) private view returns (uint256) {
        uint256 ceiling = priceCeilingUsd;
        if (ceiling == 0) return type(uint256).max;
        // price = priceNum / (reserveToken * 1e8) and ceiling = ceilingNum / (reserveToken * 1e8), same units.
        uint256 priceNum = reserveHbar * 10 ** tokenDecimals * usd;
        uint256 ceilingNum = ceiling * reserveToken * TINYBAR_PER_HBAR;
        if (priceNum >= ceilingNum) return 0;
        // A ceiling over 100x the price allows x past 9R, far beyond the 10% impact cap: nothing to clamp.
        if (ceilingNum / 100 > priceNum) return type(uint256).max;
        uint256 root = Math.sqrt(Math.mulDiv(ceilingNum, WAD * WAD, priceNum));
        return Math.mulDiv(reserveHbar, root - WAD, WAD);
    }

    function _spentToday() private view returns (uint256) {
        return block.timestamp >= windowStart + BUDGET_WINDOW ? 0 : spentTodayUsd;
    }

    /// WHBAR and token reserves of the pair in tinybar and raw token units, whichever order the pair sorts them.
    function _reserves() private view returns (uint256 reserveHbar, uint256 reserveToken) {
        if (pair == address(0)) return (0, 0);
        (uint112 r0, uint112 r1,) = ISaucerSwapV1Pair(pair).getReserves();
        return _tokenIsToken0 ? (r1, r0) : (r0, r1);
    }

    function _bookNext() private returns (int64 rc) {
        uint256 expiry = _secondWithCapacity(block.timestamp + runInterval);
        address schedule;
        (rc, schedule) = HSS.scheduleCall(address(this), expiry, scheduledGas, 0, abi.encodeCall(this.runScheduled, ()));
        if (rc != SUCCESS) {
            emit BookingFailed(rc);
            return rc;
        }
        pendingSchedule = schedule;
        nextRunAt = expiry;
        emit RunBooked(schedule, expiry);
    }

    /// HIP-1215's probe for a busy second. If none has capacity, scheduleCall reports SCHEDULE_EXPIRY_IS_BUSY.
    function _secondWithCapacity(uint256 ideal) private view returns (uint256) {
        if (HSS.hasScheduleCapacity(ideal, scheduledGas)) return ideal;
        for (uint256 delay = 1; delay <= MAX_CAPACITY_DELAY; delay *= 2) {
            if (HSS.hasScheduleCapacity(ideal + delay, scheduledGas)) return ideal + delay;
        }
        return ideal;
    }

    function _checkPolicy(uint256 impactBps, uint256 ceilingUsd, uint256 slippage) private pure {
        if (
            impactBps == 0 || impactBps > MAX_IMPACT_BPS || slippage > MAX_SLIPPAGE_BPS
                || ceilingUsd > type(uint64).max
        ) revert BadConfig();
    }

    function _associate(address asset) private {
        int64 rc = IHRC719(asset).associate();
        if (rc != SUCCESS && rc != TOKEN_ALREADY_ASSOCIATED) revert HtsCallFailed(rc);
    }

    function _int64(uint256 amount) private pure returns (int64) {
        return SafeCast.toInt64(SafeCast.toInt256(amount));
    }
}
