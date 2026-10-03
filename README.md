# Furnace

A buyback-and-burn engine on Hedera, as a [Scaffold-HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar/index) template. A token team points protocol revenue at `FurnaceEngine`. On its own Hedera Schedule Service schedule the engine buys the team's HTS token back on SaucerSwap V1, inside a USD daily budget priced by Chainlink, never above a USD price ceiling, never moving the pool by more than a set price impact, and burns what it bought with the HTS supply key it holds as the token's treasury. Total supply falls on the mirror node, where anyone can read it.

```bash
npm create scaffold-hbar@latest -- --template aarav1656/scaffold-hbar-furnace
```

The `--` matters with `npm create`: without it npm keeps `--template` for itself.

## What it does

| Integration | What the engine uses it for |
| --- | --- |
| HTS | `initialize` creates the token from the contract: finite max supply equal to total supply, the engine as treasury and sole supply-key holder, no admin, wipe, freeze, pause or KYC key. Burns are enforced by the network. |
| SaucerSwap V1 | `createPool` makes the token/WHBAR pair; `seedLiquidity` deposits the liquidity allocation with `addLiquidityETH`; every buyback is a `swapExactETHForTokens`. Pair reserves give exact constant-product price impact. |
| Exchange rate precompile (0x168) | SaucerSwap prices the pair fee in tinycents; the engine converts it to tinybar at call time, so the quote is always right. |
| Chainlink HBAR/USD | Budget and ceiling are in USD, so a team sets "$500 a day", not a moving HBAR number. Stale or non-positive answers stop the run. |
| Hedera Schedule Service (HIP-1215) | The engine books its own next run, books first and buys second, and never reverts, so a failed buyback costs one run and never the chain. |

## The buyback

Every run is sized by one function and checked against four caps in a fixed order. The spend is the smallest of:

1. **Funds**: native HBAR above `fuelReserve`. The reserve pays for the engine's own schedules and is never spent on a buyback.
2. **Budget**: the USD left in the rolling 24 hour window, converted at the Chainlink price. The USD cost of each spend rounds up, so the budget cannot be overshot.
3. **Price ceiling**: the most HBAR that can enter the pool before its spot price passes `priceCeilingUsd`, solved from `(1 + x/R)^2 <= ceiling/price`. The pool fee only lowers the real price, so the pool ends at or under the ceiling.
4. **Price impact**: `reserveHbar * maxImpactBps / (10000 - maxImpactBps)`, which is exactly x / (R + x) for the configured basis points.

If the smallest cap is under `minSpend`, the run emits `BuybackSkipped` naming the cap that bound (`NoFunds`, `BudgetSpent`, `PriceCeiling`, `ImpactCap`) and spends nothing. Otherwise the engine quotes the swap, buys with a slippage floor, measures the token balance delta and burns exactly that. A final check confirms the treasury still holds every unclaimed allocation.

`previewBuyback()` returns the same plan as a view, and `status()` returns the whole dashboard in one call without reverting on a stale oracle.

## Properties

- **The owner cannot take HBAR, LP tokens or bought tokens out.** The contract has no withdraw, sweep or rescue function; a test reads the compiled ABI and fails if a state-changing function appears that is not on the reviewed list.
- **Liquidity is locked for good.** LP tokens are minted to the engine, and no function transfers or approves them.
- **Team and liquidity allocations are never burned.** Burns come only from tokens the swap just delivered. The remainder of the supply after the liquidity allocation is the team allocation, claimable by the owner with `claimTeamAllocation(to)` once the recipient associates.
- **Policy is bounded and public.** Budget, impact (at most 10%), ceiling and slippage are owner setters with bounds and events.

## Live on Hedera testnet

| | |
| --- | --- |
| FurnaceEngine | [0.0.10839961](https://hashscan.io/testnet/contract/0.0.10839961) |
| FURN token | [0.0.10840036](https://hashscan.io/testnet/token/0.0.10840036): 1,000,000 supply, finite, engine as treasury, supply key only |
| SaucerSwap V1 pair | [0.0.10840039](https://hashscan.io/testnet/contract/0.0.10840039), LP token [0.0.10840040](https://hashscan.io/testnet/token/0.0.10840040) held by the engine |
| Manual burn | [tx](https://hashscan.io/testnet/transaction/0x389b5f7eae1a05bb09d5d6bb7fafa178b53b645dd963e2d565a5bf692bf687fc): 19,942.99 FURN bought for 1.3158 HBAR and burned |
| Network-triggered burn | [consensus 1791020653.144458104](https://hashscan.io/testnet/transaction/1791020653.144458104): the engine's own schedule bought and burned 18,948.68 FURN for 1.3850 HBAR, no transaction of ours in the window |
| Supply on the mirror node | 100,000,000,000,000 raw before, 96,110,832,443,647 raw after both burns, a fall of exactly the 3,889,167,556,353 the engine reports as `totalBurned()` |
| Running now | a 6 hour schedule, paid from the engine's own HBAR |

`yarn foundry:live` reproduces the loop and prints a HashScan link, the gas and the HBAR fee for every transaction.

## Quick start

```bash
npm create scaffold-hbar@latest -- --template aarav1656/scaffold-hbar-furnace
cd <your-project>
yarn foundry:test        # 149 unit tests, no network needed
```

Fund an ECDSA testnet account from the [Hedera faucet](https://portal.hedera.com/faucet), put its key in `packages/foundry/.env` as `DEPLOYER_PRIVATE_KEY`, then:

```bash
yarn foundry:live        # deploy, token, pool, seed, fund, manual burn, scheduled burn, 6 hour schedule
yarn next:dev            # http://localhost:3000
```

### Configure a deploy

`script/Deploy.s.sol` reads its policy from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DAILY_BUDGET_USD` | `1e8` | USD per 24 hours, 8 decimals ($1.00) |
| `MAX_IMPACT_BPS` | `500` | price impact one buyback may cause, at most 1000 |
| `PRICE_CEILING_USD` | `0` | USD per whole token, 8 decimals; 0 for none |
| `SLIPPAGE_BPS` | `300` | tolerance under the router quote, at most 1000 |
| `FUEL_RESERVE_HBAR` | `25` | whole HBAR that buybacks never touch |
| `MIN_SPEND_HBAR_E8` | `1e8` | smallest buyback in tinybar |

## Tests

149 Foundry tests, none needing a network: setup (41), buyback (41, run a second time with WHBAR sorting above the token for 42 more), automation (19) and six invariants driven by a handler that fires revenue, buybacks, policy changes, claims and automation at random. They include a fuzz test that checks spend never exceeds the tightest cap, the fuel reserve is never touched, the day's budget is never overshot and the pool never ends above the ceiling. Seventeen mutations of the contract, each breaking one guard, turn the suite red.

## Layout

```
packages/foundry/
  contracts/FurnaceEngine.sol       the whole protocol
  contracts/interfaces/             HTS, HSS, exchange rate, HIP-719, SaucerSwap V1, Chainlink
  script/Deploy.s.sol               testnet addresses and policy from the environment
  script/live-testnet.sh            yarn foundry:live
  test/Furnace*.t.sol               setup, buyback, automation, invariants
  test/mocks/                       HTS, HSS, 0x168 and a constant-product SaucerSwap V1
packages/nextjs/                    the app, plus scaffold /debug and /blockexplorer
scripts/gate.sh                     scaffolds this template from HEAD and runs the full gate
```
