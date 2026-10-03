// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// SaucerSwap V1 (a Uniswap V2 fork adapted to HTS). Its fees are priced in tinycents; callers convert them to
/// tinybar at execution time through the exchange rate system contract.
interface ISaucerSwapV1Factory {
    /// Pool creation fee in tinycents (1e-8 US cents), paid in HBAR as msg.value on `createPair`.
    function pairCreateFee() external view returns (uint256);

    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function createPair(address tokenA, address tokenB) external payable returns (address pair);
}

interface ISaucerSwapV1Pair {
    /// The HTS fungible token that represents pool shares, created by the pair.
    function lpToken() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    function price0CumulativeLast() external view returns (uint256);

    function price1CumulativeLast() external view returns (uint256);
}

interface ISaucerSwapV1Router {
    function factory() external view returns (address);

    /// The HTS token that WHBAR pools pair against.
    function whbar() external view returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}
