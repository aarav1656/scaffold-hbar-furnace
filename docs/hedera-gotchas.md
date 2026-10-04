# Hedera behaviours the engine is built around

`FurnaceEngine` depends on eighteen behaviours of the Hedera network that an Ethereum developer does not expect. Each entry gives what happens, where the contract handles it, a command that reproduces it against live testnet.

Setup for the commands (run them in `bash`; they need Foundry, `curl`, `jq` and `python3`):

```bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=https://testnet.hashio.io/api
M=https://testnet.mirrornode.hedera.com/api/v1
HSS=0x000000000000000000000000000000000000016b
FX=0x0000000000000000000000000000000000000168
ROUTER=0x0000000000000000000000000000000000004b40       # SaucerSwap V1 RouterV3, 0.0.19264
FACTORY=0x00000000000000000000000000000000000026E7     # SaucerSwap V1 factory, 0.0.9959
E=0x706947eCC0411bAdeF790282bb89b80126357D9D           # FurnaceEngine, 0.0.10839961
EID=0.0.10839961
FURN=0x0000000000000000000000000000000000A567E4        # token 0.0.10840036
PAIR=0x2989b5a6C8856143Ea04898757F360239553Cf05        # pair 0.0.10840039
OWNER=0x11Cf661848D52aEdF638658E6b68762549f74a0C
n() { awk '{print $1}'; }
```

| # | Behaviour | Handled by |
| --- | --- | --- |
| 1 | HBAR is tinybar inside the EVM and weibar at the JSON-RPC layer | all contract math in tinybar; the app converts with `parseEther` |
| 2 | `createPair` needs about 6.6M gas because it associates tokens inside the call | `createPool` documented at 8M+, the live script sends 10M |
| 3 | SaucerSwap prices the pair fee in tinycents; the exchange rate system contract converts it | `poolCreationFee()` |
| 4 | HTS token creation takes its fee from the contract's balance | `initialize` is `payable` |
| 5 | The engine must associate with the LP token before liquidity is minted to it | `createPool` through `_associate` |
| 6 | A V1 pair sorts its tokens by address, and `router.whbar()` differs from `router.WHBAR()` | `token0()` read once, both orders tested |
| 7 | V1 price accumulators are zero until the first swap | pricing from spot reserves and Chainlink |
| 8 | HTS refuses an allowance above a finite token's max supply | `seedLiquidity` approves exactly the allocation |
| 9 | HTS caps a burn at the treasury balance | burns only the swap's delta, `AllocationBreach` check |
| 10 | A scheduled call arrives with `msg.sender` equal to the booking contract | `runScheduled` and `OnlySelf` |
| 11 | A self-rescheduling call under 3M gas runs once and never books its successor | `MIN_SCHEDULED_GAS`, `scheduledGas` 4,000,000 |
| 12 | One schedule per scheduled execution | `runScheduled` books exactly once, before buying |
| 13 | An expiry more than 62 days out is refused | `MAX_INTERVAL = 60 days` |
| 14 | A second can be full | `_secondWithCapacity` probes +1 to +16 s |
| 15 | The payer needs the full gas reservation, not the gas a run burns | `fuelReserve`, runway formula |
| 16 | A balance read inside a scheduled run is short by the unreturned gas allowance | `available` can only shrink, the fuel reserve holds |
| 17 | A scheduled execution is listed under `/transactions`, not `/contracts/{id}/results` | evidence and UI read `/transactions` and the logs |
| 18 | Hashio accepts `eth_getLogs` over a 7 day span at most; Chainlink HBAR/USD has a 24 hour heartbeat | events from the mirror node; `maxOracleAge` 25 hours |

## HBAR is tinybar in the EVM and weibar over JSON-RPC

**What happens.** Hedera accounts hold HBAR with 8 decimals (tinybar). The EVM sees the same balance as `msg.value`, `address(this).balance` and `tx.gasprice` in tinybar. The JSON-RPC relay speaks 18 decimals, so a wallet sends 10 HBAR as `10e18` and the contract reads `1_000_000_000`. One tinybar is `1e10` weibar.

**In FurnaceEngine.** Every amount is tinybar: `fuelReserve`, `minSpend`, the swap value, `Burned.hbarIn`. `swapExactETHForTokens{value: spend}` takes tinybar; a spend of 200,000,000 moved exactly 2 HBAR. Token amounts are raw units of the token's own decimals.

**Reproduce.** The 35 HBAR revenue transaction reads two ways:

```bash
H=0x3c2f34fbef91cf1274604eb2328791bded4812ded2006acda1af52f2b2332693
cast tx $H value --rpc-url $RPC                       # 35000000000000000000   (weibar)
curl -s $M/contracts/results/$H | jq .amount          # 3500000000             (tinybar)
cast gas-price --rpc-url $RPC | n                     # about 880000000000 weibar = 88 tinybar per gas
```

**Source.** Our measurement.

## createPair needs about 6.6M gas

**What happens.** The pair's `initialize` associates both tokens with HTS inside the `createPair` call. With 4,000,000 gas the inner association runs out of gas, returns INSUFFICIENT_GAS, and the whole call reverts with "Safe multiple associations failed!" after burning 3,901,249 gas.

**In FurnaceEngine.** `createPool()` documents the 8M gas requirement and `live-testnet.sh` sends 10,000,000. The engine's own `createPool` used 6,622,028 gas. Hedera allows 15M per transaction, so there is room.

**Reproduce.** The engine's successful call, then a refused call at 4,000,000 gas made before the engine existed with the same factory call:

```bash
curl -s $M/contracts/results/0xc0d1579ca2a712d4e7aac065f76e62387f86434c210ee838e960f221994a486e | jq -c '{gas_limit,gas_used,result}'
# {"gas_limit":10000000,"gas_used":6622028,"result":"SUCCESS"}

H=0x2d603bee569114736dfb390b3b534af304c56bab863111da5180e0eb0008e64e
curl -s $M/contracts/results/$H | jq -c '{gas_limit,gas_used,result}'
# {"gas_limit":4000000,"gas_used":3901249,"result":"CONTRACT_REVERT_EXECUTED"}
ERR=$(curl -s $M/contracts/results/$H | jq -r .error_message)
cast abi-decode "f()(string)" "0x${ERR:10}"            # "Safe multiple associations failed!"
```

**Source.** Our measurement; a probe contract that preceded the engine ran the 4M attempt and a 10M retry that used 6,616,396 gas.

## The pair fee is in tinycents, converted through 0x168

**What happens.** SaucerSwap's factory exposes `pairCreateFee()` in tinycents: 20,000,000,000 is $2.00. The exchange rate system contract at 0x168 converts tinycents to tinybar at the current network rate, so the HBAR price of a pair moves with the market.

**In FurnaceEngine.** `poolCreationFee()` is `EXCHANGE_RATE.tinycentsToTinybars(factory.pairCreateFee())`. `createPool` reverts `InsufficientFee(required, sent)` below it, forwards exactly the fee to the factory and leaves any excess in the engine as revenue. At creation the fee was 1,995,165,050 tinybar.

**Reproduce.**

```bash
cast call $FACTORY "pairCreateFee()(uint256)" --rpc-url $RPC | n                    # 20000000000
cast call $FX "tinycentsToTinybars(uint256)(uint256)" 20000000000 --rpc-url $RPC | n  # follows the live rate: 1967748600 on this read, 1995165050 at creation
cast call $E "poolCreationFee()(uint256)" --rpc-url $RPC | n                         # the same figure as the line above
# what the engine paid, from its PoolCreated event: 0x76ebcd7a
cast to-dec 0x76ebcd7a                                                                # 1995165050
```

The conversion is pinned by `test_poolCreationFee_isThePairTinycentFeeAtTheCurrentRate`, and mutation 14 (the fee used without the 0x168 conversion) turns it red.

**Source.** Our measurement.

## HTS token creation takes its fee from the contract's balance

**What happens.** `createFungibleToken` called from a contract charges the creation fee to the contract's own balance. Send more than the fee and the remainder stays in the contract.

**In FurnaceEngine.** `initialize` forwards `msg.value`. The call carried 20 HBAR and HTS took 1,188,699,027 tinybar (11.887 HBAR). The pair's LP token creation carries the identical fee inside `createPool`.

**Reproduce.** The mirror node's charged fee for `initialize` less its gas leaves exactly the HTS fee, and `createPool` leaves the same figure:

```bash
python3 -c "print(1208270355 - 232992*84, 1744949379 - 6622028*84)"   # 1188699027 1188699027
curl -s "$M/transactions?timestamp=1791020384.150886346" | jq '.transactions[0].charged_tx_fee'   # 1208270355
curl -s "$M/transactions?timestamp=1791020396.944049104" | jq '.transactions[0].charged_tx_fee'   # 1744949379
```

Unit tests: `test_initialize_leavesWhatTheHtsFeeDoesNotTakeInTheEngine`, `test_initialize_revertsWhenTheFeeIsNotCovered`.

**Source.** Our measurement.

## The engine associates with the LP token before liquidity is minted to it

**What happens.** `addLiquidityETH(..., to = engine)` mints an HTS LP token. An account receives an HTS token only if it is associated (HIP-719), and the engine's account has no automatic association slots. `associate()` at the token's own address returns 22 on success and 194 when already associated.

**In FurnaceEngine.** `createPool` reads the pair's `lpToken()` and calls `_associate`, which accepts 22 and 194 and reverts `HtsCallFailed` on anything else. Mutation 9 (the association deleted) breaks the setup of every test that creates a pool.

**Reproduce.**

```bash
curl -s $M/accounts/$EID | jq .max_automatic_token_associations                          # 0
curl -s $M/accounts/$EID/tokens | jq -c '.tokens[]|{token_id,automatic_association,balance}'
# {"token_id":"0.0.10840036","automatic_association":false,"balance":0}                    FURN, associated at creation
# {"token_id":"0.0.10840040","automatic_association":false,"balance":316227765016}        the LP token, associated by createPool
```

**Source.** Our measurement.

## A V1 pair sorts its tokens by address

**What happens.** The pair stores the lower address as `token0`. WHBAR (`0x...3aD2`) sorts below any token created recently, so `getReserves()` returns (WHBAR, token). The router also exposes two WHBAR addresses: `whbar()` is the HTS token the swap paths use, `WHBAR()` is the wrapper contract.

**In FurnaceEngine.** `createPool` stores `_tokenIsToken0 = pair.token0() == token` once and `_reserves()` swaps the two values when needed. The whole buyback suite runs a second time with the order flipped (`FurnaceReversedOrderTest`).

**Reproduce.**

```bash
cast call $PAIR "token0()(address)" --rpc-url $RPC                  # 0x0000000000000000000000000000000000003aD2
cast call $PAIR "token1()(address)" --rpc-url $RPC                  # the FURN token
cast call $ROUTER "whbar()(address)" --rpc-url $RPC                 # 0x...3aD2  the HTS token, used in paths
cast call $ROUTER "WHBAR()(address)" --rpc-url $RPC                 # 0x...3aD1  the wrapper contract
```

Unit tests: `test_poolOrder_matchesTheAddressSort`, `test_poolOrder_tokenIsToken0WhenWhbarSortsAbove`, and the 41 buyback tests run again in `FurnaceReversedOrderTest`.

**Source.** Our measurement.

## V1 price accumulators are zero until the first swap

**What happens.** `price0CumulativeLast` and `price1CumulativeLast` exist on the V1 pair but read 0 until the pair's first trade, and a pool with no trades has no time-weighted price. Measured on a probe pair before and after its first swap.

**In FurnaceEngine.** The engine never reads them. Impact math uses spot reserves, which are exact for a constant-product trade, and the ceiling uses the Chainlink USD price. A fresh pool works on its first buyback.

**Reproduce.** On the engine's pair, which has traded, both are non-zero:

```bash
cast call $PAIR "price0CumulativeLast()(uint256)" --rpc-url $RPC | n
cast call $PAIR "price1CumulativeLast()(uint256)" --rpc-url $RPC | n
```

**Source.** Our measurement on the probe pair; the engine's pair confirms the non-zero side.

## HTS refuses an allowance above max supply

**What happens.** `approve` on an HTS token is a Token Service allowance, and HTS refuses an allowance above a finite token's `max_supply`. The usual `type(uint256).max` approval reverts.

**In FurnaceEngine.** `seedLiquidity` approves exactly the liquidity allocation to the router, which is below the max supply by construction.

**Reproduce.** From the team wallet, which holds FURN:

```bash
cast call $FURN "approve(address,uint256)(bool)" $ROUTER 100000000000000 --from $OWNER --rpc-url $RPC   # true  (max_supply)
cast call $FURN "approve(address,uint256)(bool)" $ROUTER 100000000000001 --from $OWNER --rpc-url $RPC   # reverts AMOUNT_EXCEEDS_TOKEN_MAX_SUPPLY
```

## HTS caps a burn at the treasury balance

**What happens.** `burnToken` burns from the treasury. A burn larger than the treasury balance reverts with INSUFFICIENT_TOKEN_BALANCE. The treasury here is the engine, which also holds the unclaimed team allocation and the unseeded liquidity allocation, so the network alone would let a careless burn eat them.

**In FurnaceEngine.** `buyback` burns the measured swap delta and then requires the engine's token balance to cover `teamUnclaimed + liquidityUnseeded`, reverting `AllocationBreach` and rolling the whole run back otherwise.

**Reproduce.** The negative case lives in the unit suite, because the engine exposes no function that burns an amount the caller chooses. Mutation 8 burns the whole treasury balance and mutation 13 deletes the assertion:

```bash
cd packages/foundry
forge test --match-test test_burn_aBurnThatTakesMoreThanWasBoughtIsCaughtAndRolledBack
forge test --match-test test_burn_neverTouchesTheTeamOrLiquidityAllocations
```

On chain, the allocation survived four burns: after the first burn the treasury still held all of it, and `claimTeamAllocation` paid 60,000,000,000,000 raw units ([testnet-evidence.md](testnet-evidence.md#4-team-allocation)).

**Source.** A burn of 7e13 against a 6e13 treasury on the probe contract reverted `burn failed, INSUFFICIENT_TOKEN_BALANCE`; the unit tests above.

## A scheduled call arrives with msg.sender equal to the booking contract

**What happens.** The network executes a schedule created by a contract as a call from that contract. The callee sees `msg.sender == address(this)` when it booked itself.

**In FurnaceEngine.** `runScheduled` is external, and its one access check is `if (msg.sender != address(this)) revert OnlySelf();`. `buyback` accepts the owner or the engine (`onlyOwnerOrSelf`), so the scheduled run can reach it and a stranger cannot.

**Reproduce.** The negative cases are refused, the positive case is on chain:

```bash
cast call $E "runScheduled()" --rpc-url $RPC                                  # reverts with data 0x14d4a4e8
cast sig "OnlySelf()"                                                         # 0x14d4a4e8
cast call $E "buyback()(uint256)" --from 0x000000000000000000000000000000000000dEaD --rpc-url $RPC   # reverts 0xc28254e4
cast sig "NotOwnerOrSelf()"                                                   # 0xc28254e4
curl -s "$M/transactions?timestamp=1791020653.144458104" | jq -c '.transactions[0]|{name,result,scheduled}'
# {"name":"CONTRACTCALL","result":"SUCCESS","scheduled":true}
```

Unit tests: `test_runScheduled_onlyTheEngineItselfMayCallIt`, `test_buyback_isOwnerOrSelfOnly`. Mutation 7 deletes the access check.

## 3,000,000 gas is the floor for a self-rescheduling call

**What happens.** `scheduleCall` alone costs about 1.4M gas. Booked with too little gas, the scheduled function runs, its inner `scheduleCall` runs out of gas, and the outer call still reports SUCCESS. The chain ends and nothing says so.

**In FurnaceEngine.** `MIN_SCHEDULED_GAS = 3_000_000`. The constructor reverts `BadConfig()` below it, and the deploy script books with 4,000,000. Gas that is not used is refunded, so the headroom is nearly free.

**Reproduce.**

```bash
cast call $E "MIN_SCHEDULED_GAS()(uint256)" --rpc-url $RPC | n    # 3000000
cast call $E "scheduledGas()(uint256)" --rpc-url $RPC | n         # 4000000
# the network fee of the first scheduled run, which booked its successor and burned
curl -s "$M/transactions?timestamp=1791020653.144458104" | jq '.transactions[0].charged_tx_fee'   # 141794436
```

Unit test: `test_constructor_rejectsBadConfig` covers the floor.

## One schedule per scheduled execution

**What happens.** A scheduled execution may book exactly one schedule. A second `scheduleCall` in the same execution fails with `NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION` and fails the whole transaction.

**In FurnaceEngine.** `runScheduled` calls `_bookNext` once and nothing under `buyback()` books. Booking goes first so a failing buyback cannot cost the chain. A booking that fails sets `runInterval` to 0, so automation reads as off and the owner restarts it.

**Reproduce.** The first scheduled execution carries exactly one `SCHEDULECREATE` child and one `RunBooked` event:

```bash
curl -s "$M/transactions?timestamp=gte:1791020653.144458104&timestamp=lte:1791020653.144458200" |
  jq '[.transactions[]|select(.name=="SCHEDULECREATE")]|length'     # 1
curl -s "$M/contracts/$EID/results/logs?order=asc&timestamp=1791020653.144458104" |
  jq -r '.logs[]|.topics[0][0:10]'                                  # 0x08157f4d (RunBooked), 0xe6d083b0 (Burned), 0x27b49ad4 (ScheduledRun)
```

Unit tests: `test_runScheduled_booksItsSuccessorBeforeItBuysAndBurns`, `test_runScheduled_chainsAndStaysInsideTheDailyBudget`, `test_runScheduled_aLostBookingTurnsAutomationOffButStillBuys`.

## Expiry is refused beyond 62 days

**What happens.** The network refuses a schedule expiring more than 62 days out. The refusal comes back as a response code, not a revert.

**In FurnaceEngine.** `MAX_INTERVAL = 60 days`, two days inside the limit. `startAutomation` reverts `BadInterval` outside 60 seconds to 60 days.

**Reproduce.** `hasScheduleCapacity` flips at 62 days:

```bash
NOW=$(date -u +%s)
for d in 61 62 63; do
  printf "%s days -> " $d
  cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW + d*86400)) 4000000 --rpc-url $RPC | tail -1
done
# 61 days -> true
# 62 days -> true
# 63 days -> false
cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW - 10)) 4000000 --rpc-url $RPC | tail -1   # false, so the predicate is live
```

Unit test: `test_start_enforcesTheIntervalBounds`.

## A busy second refuses new schedules

**What happens.** Each consensus second holds a bounded amount of scheduled gas. A booking for a full second fails with `SCHEDULE_EXPIRY_IS_BUSY`. [HIP-1215](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-1215.md) adds `hasScheduleCapacity(expirySecond, gasLimit)` so a contract can ask first.

**In FurnaceEngine.** `_bookNext` asks `_secondWithCapacity` before it calls `scheduleCall`. The function returns the ideal second (`block.timestamp + runInterval`) when it has capacity and otherwise probes +1, +2, +4, +8 and +16 seconds, so a busy second delays a run instead of ending the chain.

**Reproduce.**

```bash
NOW=$(date -u +%s)
INT=$(cast call $E "runInterval()(uint256)" --rpc-url $RPC | n)
GAS=$(cast call $E "scheduledGas()(uint256)" --rpc-url $RPC | n)
cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW + INT)) $GAS --rpc-url $RPC | tail -1   # true
```

Unit tests with a mock Schedule Service that marks seconds busy: `test_start_probesLaterSecondsWhenTheIdealOneIsBusy`, `test_start_givesUpWhenEveryProbedSecondIsBusy`.

**Source.** HIP-1215.

## The payer needs the full gas reservation, not the gas a run burns

**What happens.** The network checks the payer of a scheduled call against the gas reserved, `gasLimit x gas price`, not the gas burned. An engine holding more than a run costs can still fail with `INSUFFICIENT_PAYER_BALANCE`. A 4,000,000 gas booking reserves 3.36 to 3.52 HBAR (84 to 88 tinybar per gas) while a run is charged about 1.40 to 1.42 HBAR.

**In FurnaceEngine.** The schedule's payer is the engine's native balance, the same pool as the buyback budget. `fuelReserve` is the part buybacks never spend, so the fee of every run stays covered. The runway, the number of runs the fuel reserve pays for on its own, is

```
runway = (fuelReserve - scheduledGas x gasPrice) / chargePerRun + 1
```

The `+ 1` counts the last run, which needs the reservation but only spends the charge. With the deployed 25 HBAR reserve, a 3.52 HBAR reservation and 1.4179 HBAR per run: `(25 - 3.52) / 1.4179 + 1` = 16 runs, four days at a 6 hour interval. HBAR sent to the engine as revenue extends it, because everything above the reserve pays fees and buys alike.

**Reproduce.**

```bash
GP=$(cast gas-price --rpc-url $RPC | n)                          # weibar per gas
TB=$((GP / 10000000000))                                         # tinybar per gas, 87 to 88
GAS=$(cast call $E "scheduledGas()(uint256)" --rpc-url $RPC | n)
FUEL=$(cast call $E "fuelReserve()(uint256)" --rpc-url $RPC | n)
COST=$(curl -s "$M/transactions?timestamp=1791020653.144458104" | jq '.transactions[0].charged_tx_fee')   # 141794436
python3 -c "r=$GAS*$TB; print('reservation', r/1e8, 'HBAR  runway', ($FUEL-r)/$COST+1, 'runs')"
# reservation 3.52 HBAR  runway 16.1 runs  at 88 tinybar per gas (3.48 and 16.2 at 87)

# what each scheduled run was charged
for ts in 1791020653.144458104 1791042280.004353208 1791063880.037958663; do
  curl -s "$M/transactions?timestamp=$ts" | jq -c '.transactions[0]|{scheduled,charged_tx_fee}'
done
# 141794436, 140106407, 140106407
```

## A balance read inside a scheduled run is short by the unreturned allowance

**What happens.** During a scheduled call the account has already been debited the whole gas allowance; the refund of unused gas lands when the call returns. A contract that reads its own balance mid-run sees it short by the unreturned part. A testnet run recorded 0.73 HBAR seen against 2.2245 HBAR after settlement.

**In FurnaceEngine.** `_plan` reads `address(this).balance` to size `available = balance - fuelReserve`. A short read can only shrink `available`, never grow it, so inside a scheduled run the spend is smaller or equal and the fuel reserve stays untouched. The live scheduled runs were bound by the impact cap, so the read did not bind them.

**Reproduce.** The first scheduled run spent exactly the impact cap, so the balance read was not the binding cap:

```bash
python3 -c "print(2631578947*500//9500)"      # 138504155, the spend in the Burned event of that run
```

Unit tests: `test_funds_spendIsAllRevenueAboveTheFuelReserve`, `test_funds_nothingAboveTheReserveSkipsTheRun`, `invariant_theFuelReserveIsNeverSpent`.

## Scheduled executions live under /transactions, not /contracts/{id}/results

**What happens.** A scheduled execution is a `CONTRACTCALL` transaction with `scheduled: true` and a parent chain of child records (the schedule creation, the wrap and unwrap transfers, the token burn). The mirror node lists it under `/transactions` and its events under `/contracts/{id}/results/logs`, and omits it from `/contracts/{id}/results`.

**In FurnaceEngine.** The evidence and the app read `/transactions?timestamp=` and the logs endpoint; neither relies on `/contracts/{id}/results` for scheduled runs. `yarn foundry:live` detects the run through `nextRunAt()` changing, then reads the mirror's supply.

**Reproduce.**

```bash
curl -s "$M/contracts/$EID/results?timestamp=1791020653.144458104" | jq '.results|length'                # 0
curl -s "$M/transactions?timestamp=1791020653.144458104" | jq -c '.transactions[0]|{name,scheduled}'     # {"name":"CONTRACTCALL","scheduled":true}
curl -s "$M/contracts/$EID/results/logs?timestamp=1791020653.144458104" | jq '.logs|length'              # 3
```

**Source.** Our measurement.

## Events come from the mirror node, and the Chainlink feed has a 24 hour heartbeat

**What happens.** Hashio accepts an `eth_getLogs` only when its block range spans 7 days or less. The Chainlink HBAR/USD feed updates at least every 24 hours, so a healthy answer can be almost a day old.

**In FurnaceEngine.** The app reads events from the mirror node's `/contracts/{id}/results/logs`. `maxOracleAge` is 90,000 seconds (25 hours), one hour past the heartbeat, and `hbarUsd()` reverts `StaleOracle` beyond it. `status()` swallows that revert and reads USD figures as zero, so a dashboard never breaks on a late feed, while `buyback()` stops.

**Reproduce.**

```bash
curl -s -X POST $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"'$E'","fromBlock":"0x2625a00","toBlock":"latest"}]}' | jq -r .error.message
# ... exceed the maximum allowed duration of 7 days (604800 seconds) ...

cast call $E "maxOracleAge()(uint256)" --rpc-url $RPC | n                                     # 90000
cast call 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a "decimals()(uint8)" --rpc-url $RPC | n    # 8
cast call 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC
# (roundId, answer, startedAt, updatedAt, answeredInRound): answer is HBAR/USD with 8 decimals
```

Unit tests: `test_oracle_staleAnswerRevertsTheBuyback`, `test_oracle_ageExactlyAtTheLimitIsStillFresh`, `test_status_staysReadableWhenTheOracleGoesStale`, `test_runScheduled_neverRevertsOnAStaleOracleAndKeepsTheChain`.

**Source.** Our measurement.
