// SPDX-License-Identifier: MIT
// Router and pair maths follow Uniswap V2 (GPL-3.0 reference, re-derived here); the factory fee, LP-token and HTS
// association behaviour follows what SaucerSwap V1 does on Hedera testnet, measured in research/furnace-spike.md.
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IHRC719 } from "../../contracts/interfaces/IHRC719.sol";
import { IExchangeRate } from "../../contracts/interfaces/IExchangeRate.sol";
import { MockHtsToken } from "./MockHtsToken.sol";

/// @notice Test stand-in for the exchange rate system contract at 0x168 (`vm.etch`, then `setTinybarPerCent`).
contract MockExchangeRate is IExchangeRate {
    uint256 public tinybarPerCent;

    function setTinybarPerCent(uint256 value) external {
        tinybarPerCent = value;
    }

    function tinycentsToTinybars(uint256 tinycents) external view returns (uint256) {
        return tinycents * tinybarPerCent / 1e8;
    }
}

/// @notice A V1 pair. It associates itself with both tokens as the real factory does, creates its own HTS LP token,
/// and holds the tokens it trades; the WHBAR side is tracked as a reserve number only.
contract MockV1Pair {
    address public immutable token0;
    address public immutable token1;
    address public immutable lpToken;
    address public immutable router;
    uint112 private _reserve0;
    uint112 private _reserve1;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    error OnlyRouter();

    constructor(address a, address b, address router_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        router = router_;
        lpToken = address(new MockHtsToken("SaucerSwap LP", "SSLP", 8));
        IHRC719(token0).associate();
        IHRC719(token1).associate();
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, uint32(block.timestamp));
    }

    function update(uint112 r0, uint112 r1) external {
        if (msg.sender != router) revert OnlyRouter();
        _reserve0 = r0;
        _reserve1 = r1;
    }

    function payout(address token, address to, uint256 amount) external {
        if (msg.sender != router) revert OnlyRouter();
        IERC20(token).transfer(to, amount);
    }

    /// Lets a test move the market without trading, as another trader would.
    function setReserves(uint112 r0, uint112 r1) external {
        _reserve0 = r0;
        _reserve1 = r1;
    }

    function mintLp(address to, uint256 amount) external {
        if (msg.sender != router) revert OnlyRouter();
        MockHtsToken(lpToken).mint(to, amount);
    }
}

/// @notice The V1 factory. `createPair` wants at least `pairCreateFee` tinycents converted at the exchange rate, and
/// answers `UniswapV2: PAIR_EXISTS` for a second pair of the same tokens.
contract MockV1Factory {
    IExchangeRate private constant FX = IExchangeRate(address(0x168));

    uint256 public pairCreateFee = 20_000_000_000;
    address public router;
    uint256 public lastFeePaid;
    mapping(address a => mapping(address b => address)) public getPair;

    function setRouter(address router_) external {
        router = router_;
    }

    function createPair(address a, address b) external payable returns (address pair) {
        require(getPair[a][b] == address(0), "UniswapV2: PAIR_EXISTS");
        uint256 fee = FX.tinycentsToTinybars(pairCreateFee);
        require(msg.value >= fee, "fee too low");
        lastFeePaid = msg.value;
        pair = address(new MockV1Pair(a, b, router));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

/// @notice The V1 router the engine trades through: constant product with the 0.3% fee. Value is tinybar, as inside
/// the Hedera EVM. `haircutBps` makes `swapExactETHForTokens` deliver less than `getAmountsOut` quoted, so a test can
/// play a market that moved between the quote and the fill.
contract MockV1Router {
    uint256 private constant BPS = 10_000;

    MockV1Factory public immutable factory;
    address public immutable whbar;
    uint256 public haircutBps;
    uint256 public lastSwapValue;
    uint256 public swapCount;
    /// When set the swap takes the HBAR and delivers nothing, to play a router that ignores minimum output.
    bool public stingy;

    constructor(MockV1Factory factory_, address whbar_) {
        factory = factory_;
        whbar = whbar_;
    }

    function setStingy(bool value) external {
        stingy = value;
    }

    function setHaircutBps(uint256 value) external {
        haircutBps = value;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(block.timestamp <= deadline, "EXPIRED");
        MockV1Pair pair = MockV1Pair(factory.getPair(token, whbar));
        require(address(pair) != address(0), "NO_PAIR");
        (uint256 rHbar, uint256 rToken) = _reserves(pair, token);
        if (rHbar == 0 && rToken == 0) {
            (amountToken, amountETH) = (amountTokenDesired, msg.value);
        } else {
            uint256 optimalEth = amountTokenDesired * rHbar / rToken;
            if (optimalEth <= msg.value) {
                require(optimalEth >= amountETHMin, "INSUFFICIENT_B_AMOUNT");
                (amountToken, amountETH) = (amountTokenDesired, optimalEth);
            } else {
                uint256 optimalToken = msg.value * rToken / rHbar;
                require(optimalToken <= amountTokenDesired && optimalToken >= amountTokenMin, "INSUFFICIENT_A_AMOUNT");
                (amountToken, amountETH) = (optimalToken, msg.value);
            }
        }
        require(amountToken >= amountTokenMin && amountETH >= amountETHMin, "INSUFFICIENT_AMOUNT");

        require(IERC20(token).transferFrom(msg.sender, address(pair), amountToken), "TRANSFER_FAILED");
        uint256 lpSupply = IERC20(pair.lpToken()).totalSupply();
        liquidity = lpSupply == 0
            ? Math.sqrt(amountToken * amountETH)
            : Math.min(amountToken * lpSupply / rToken, amountETH * lpSupply / rHbar);
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        pair.mintLp(to, liquidity);
        _setReserves(pair, token, rHbar + amountETH, rToken + amountToken);

        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{ value: msg.value - amountETH }("");
            require(ok, "REFUND_FAILED");
        }
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        require(path.length == 2 && path[0] == whbar, "INVALID_PATH");
        MockV1Pair pair = MockV1Pair(factory.getPair(path[0], path[1]));
        require(address(pair) != address(0), "NO_PAIR");
        (uint256 rHbar, uint256 rToken) = _reserves(pair, path[1]);
        require(rHbar > 0 && rToken > 0, "INSUFFICIENT_LIQUIDITY");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * 997 * rToken / (rHbar * 1000 + amountIn * 997);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        amounts = getAmountsOut(msg.value, path);
        amounts[1] = amounts[1] * (BPS - haircutBps) / BPS;
        if (stingy) {
            ++swapCount;
            return amounts;
        }
        require(amounts[1] >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        MockV1Pair pair = MockV1Pair(factory.getPair(path[0], path[1]));
        (uint256 rHbar, uint256 rToken) = _reserves(pair, path[1]);
        _setReserves(pair, path[1], rHbar + msg.value, rToken - amounts[1]);
        pair.payout(path[1], to, amounts[1]);
        lastSwapValue = msg.value;
        ++swapCount;
    }

    function _reserves(MockV1Pair pair, address token) private view returns (uint256 rHbar, uint256 rToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return pair.token0() == token ? (r1, r0) : (r0, r1);
    }

    function _setReserves(MockV1Pair pair, address token, uint256 rHbar, uint256 rToken) private {
        (uint112 r0, uint112 r1) = pair.token0() == token
            // forge-lint: disable-next-line(unsafe-typecast)
            ? (uint112(rToken), uint112(rHbar))
            // forge-lint: disable-next-line(unsafe-typecast)
            : (uint112(rHbar), uint112(rToken));
        pair.update(r0, r1);
    }
}

/// @notice Chainlink aggregator with a settable answer and timestamp.
contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
