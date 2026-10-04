# Testnet evidence

**3 burns executed by the Hedera network on the engine's own schedule, 0 triggered by a person; supply 1,000,000 to 959,430.9642213 FURN (4.06% burned), plus two refusals on chain: a buy TooSoon inside the minimum gap and a buy refused as TwapDeviation right after a swap moved the pool.** Counted from the mirror node on engine v2 at 2026-10-04 20:28 UTC. The owner's first `buyback()` is the only burn with `scheduled: false`. Engine v1, the earlier deployment, keeps burning on its own schedule: 5 scheduled burns, 10.57% of its supply.

```bash
M=https://testnet.mirrornode.hedera.com/api/v1; E=0x706947eCC0411bAdeF790282bb89b80126357D9D
curl -s "$M/contracts/$E/results/logs?order=asc&limit=100" | jq -r '.logs[]|select(.topics[0]|startswith("0xe6d083b0"))|.timestamp' |
  while read ts; do curl -s "$M/transactions?timestamp=$ts" | jq -r '.transactions[0].scheduled'; done | sort | uniq -c   # 5 true, 1 false (the manual buyback)
curl -s $M/tokens/0.0.10840036 | jq -r .total_supply                                                               # 89430152857744
```

Every transaction below is on Hedera testnet, read from the mirror node and Hashio on 2026-10-04. Each row says what it proves and each section carries commands that re-check the post-condition. A transaction hash proves the network accepted a call. The check beside it reads the state the call was supposed to produce.

The engine is one deployment of `FurnaceEngine`. It created its own token, made its own SaucerSwap V1 pair, and has burned six times: once on a manual `buyback()`, and five times on schedules it booked for itself. The counts below are read from the mirror node on 2026-10-04 at 14:29 UTC. `yarn foundry:live` runs the same flows from a fresh deploy and prints a HashScan link per step.

## Engine v2 (canonical)

| Thing | Value |
| --- | --- |
| FurnaceEngine v2 | `0x3249617e95785640140A05f55Fd9c798F0E116Df` [0.0.10860653](https://hashscan.io/testnet/contract/0x3249617e95785640140A05f55Fd9c798F0E116Df), Sourcify `exact_match`, runtime 18,209 bytes |
| FURN | `0x0000000000000000000000000000000000A5B86E` token [0.0.10860654](https://hashscan.io/testnet/token/0.0.10860654): 1,000,000 FURN, 8 decimals, finite supply, the engine as treasury, no admin, wipe, freeze, pause or KYC key |
| SaucerSwap V1 pair | `0xfa7511E92d54c29E469A88aE67334b7b1c2C0806` [0.0.10860656](https://hashscan.io/testnet/contract/0xfa7511E92d54c29E469A88aE67334b7b1c2C0806), LP token [0.0.10860657](https://hashscan.io/testnet/token/0.0.10860657) held by the engine |
| Owner | `0x11Cf661848D52aEdF638658E6b68762549f74a0C` |
| Policy | daily budget $5.00, lot $0.30, minimum gap 900 s, price bound 5% above the pair average, impact cap 5%, slippage 3%, fuel reserve 25 HBAR, schedule every 2100 s |
| Setup | initialize [tx](https://hashscan.io/testnet/transaction/0x6b033b51e782ba9a0bcaf24e1a70915ba631e9140113af7145bb6bdd3d27a47d), createPool [tx](https://hashscan.io/testnet/transaction/0xd578043aaf37f50332d419133bca9e396c937da045bdaf1da5549209f484745e), seedLiquidity 100 HBAR [tx](https://hashscan.io/testnet/transaction/0xe20c87179b933a78b0a9d67e929838653d82f2d9c99409421ee9d72f060441e1), plain revenue 25 HBAR [tx](https://hashscan.io/testnet/transaction/0x2eea7ea27960bec02aee3dd60780dfcc433c95f77fbaadf49a67dfd55bcbc010), tagged revenue `depositRevenue("swap-fees")` 40 HBAR [tx](https://hashscan.io/testnet/transaction/0x102224a1d7d1db4dcd7ce9e0231880fc1638392d41e55f5f0f38fc6f0b17f37b), startAutomation [tx](https://hashscan.io/testnet/transaction/0xf1ab98a0e05ef738f2fea4550c8a8b1680e5698d3039076eabc693ea613719d9) |

Burns, read from the engine's `Burned` logs and the transaction each came from:

| Event | Consensus time | Scheduled | HBAR spent (tinybar) | FURN burned (raw) | Supply after | Link |
| --- | --- | --- | --- | --- | --- | --- |
| Owner buyback() | 1791139225.382740220 | false | 292,608,047 | 1,133,843,256,835 | 98,866,156,743,165 | [tx](https://hashscan.io/testnet/transaction/1791139225.382740220) |
| Network-triggered burn | 1791141365.032140514 | true | 290,773,551 | 1,064,714,082,776 | 97,801,442,660,389 | [tx](https://hashscan.io/testnet/transaction/1791141365.032140514) |
| Network-triggered burn | 1791143464.008715208 | true | 289,311,558 | 1,002,921,300,328 | 96,798,521,360,061 | [tx](https://hashscan.io/testnet/transaction/1791143464.008715208) |
| Network-triggered burn | 1791145563.042153208 | true | 289,311,558 | 855,424,937,931 | 95,943,096,422,130 | [tx](https://hashscan.io/testnet/transaction/1791145563.042153208) |

Totals on 2026-10-04 20:28 UTC: `totalBurned()` 4,056,903,577,870, mirror `total_supply` 95,943,096,422,130, which sum to 100,000,000,000,000 (4.057% burned). `totalSpentHbar()` 1,162,004,714 tinybar. The next run is booked for consensus second 1791147662.

Refusals, read from the engine's `BuybackSkipped` logs. Each is a successful transaction with no `Burned` log and no change in the engine's HBAR beyond gas:

| Refusal | Consensus time | Reason | Burned | Link |
| --- | --- | --- | --- | --- |
| `BuybackSkipped(TooSoon)` | 1791139238.687629508 | inside the 900 s minimum gap, 13 seconds after the manual burn | 0 | [tx](https://hashscan.io/testnet/transaction/1791139238.687629508) |
| `BuybackSkipped(TwapDeviation)` | 1791144395.571796104 | spot 11.30% above the pair average after a 6 HBAR swap, bound 5% | 0 | [tx](https://hashscan.io/testnet/transaction/1791144395.571796104) |

The second refusal follows a [6 HBAR swap](https://hashscan.io/testnet/transaction/0x254c92f73c72060b953995a311428b7d4db4afa380367bc4886bdd84b5cc5dd8) by the deployer through the SaucerSwap router, which moved spot 11.30% above the pair's average price since the engine's last snapshot (`twap()` read 0, 29553, 922, 1130 after the swap: state, average in tinybar per whole token, window in seconds, deviation in basis points). The engine's total burned before and after was 3,201,478,639,939 and its balance 63.7516 HBAR both times.

Revenue by source, from the `RevenueReceived` and `RevenueTagged` logs: 25 HBAR untagged, 40 HBAR tagged `swap-fees`.

Re-check all of it with one command: `bash scripts/verify-evidence.sh` prints a PASS or FAIL row per claim for engine v2 and for engine v1.

### Engine v2 re-check

```bash
E2=0x3249617e95785640140A05f55Fd9c798F0E116Df
M=https://testnet.mirrornode.hedera.com/api/v1
curl -s $M/tokens/0.0.10860654 | jq -r .total_supply                                       # 95943096422130
cast call $E2 "totalBurned()(uint256)" --rpc-url https://testnet.hashio.io/api            # 4056903577870
cast call $E2 "twap()(uint8,uint256,uint256,uint256)" --rpc-url https://testnet.hashio.io/api
curl -s "$M/contracts/$E2/results/logs?order=asc&limit=100" | jq -r '.logs[]|select(.topics[0]=="0xd04c73a674398883618b0ba9cbd53730a202476c36122338ce8a7df9ac26cdb5")|"\(.timestamp) \(.data)"'   # 6 TooSoon, 10 TwapDeviation
```

## Engine v1, the earlier deployment

Everything below records engine v1 `0x706947eCC0411bAdeF790282bb89b80126357D9D`, deployed first and left running on its own 6 hour schedule. Its commands run unchanged.

## Setup for every command

Save this as `setup.sh` and `source` it. The commands need Foundry (`cast`), `curl`, `jq` and `python3`. Run them in `bash`.

```bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=https://testnet.hashio.io/api
M=https://testnet.mirrornode.hedera.com/api/v1
E=0x706947eCC0411bAdeF790282bb89b80126357D9D        # FurnaceEngine, contract 0.0.10839961
EID=0.0.10839961
FURN=0x0000000000000000000000000000000000A567E4     # token 0.0.10840036
TID=0.0.10840036
PAIR=0x2989b5a6C8856143Ea04898757F360239553Cf05     # SaucerSwap V1 pair 0.0.10840039
LP=0x0000000000000000000000000000000000A567E8       # LP token 0.0.10840040
OWNER=0x11Cf661848D52aEdF638658E6b68762549f74a0C    # owner and team wallet, 0.0.10855086
n() { awk '{print $1}'; }                           # cast prints "123 [1.23e2]"; keep the exact value

# gas, result and amount of one transaction hash, then the fee the network charged (tinybar, 1 HBAR = 1e8)
tx() {
  local ts; ts=$(curl -s "$M/contracts/results/$1" | jq -r .timestamp)
  curl -s "$M/contracts/results/$1" | jq -c '{timestamp,gas_used,result,amount}'
  curl -s "$M/transactions?timestamp=$ts" | jq -c '.transactions[0]|{name,result,scheduled,charged_tx_fee}'
}

# event logs of the engine by event signature; the mirror needs a timestamp range of at most 7 days when it
# filters by topic, so S and U bound the window (the engine was deployed at 1791020016)
S=1791020000; U=1791600000
logs() {
  curl -s "$M/contracts/${2:-$EID}/results/logs?topic0=$(cast keccak "$1")&order=asc&limit=100&timestamp=gte:$S&timestamp=lte:$U"
}
```

| Actor | EVM address | Hedera id |
| --- | --- | --- |
| FurnaceEngine | `0x706947eCC0411bAdeF790282bb89b80126357D9D` | [0.0.10839961](https://hashscan.io/testnet/contract/0.0.10839961) |
| FURN token, created by the engine | `0x0000000000000000000000000000000000A567E4` | [0.0.10840036](https://hashscan.io/testnet/token/0.0.10840036) |
| SaucerSwap V1 pair | `0x2989b5a6C8856143Ea04898757F360239553Cf05` | [0.0.10840039](https://hashscan.io/testnet/contract/0x2989b5a6C8856143Ea04898757F360239553Cf05) |
| LP token | `0x0000000000000000000000000000000000A567E8` | [0.0.10840040](https://hashscan.io/testnet/token/0.0.10840040) |
| Owner and team wallet | `0x11Cf661848D52aEdF638658E6b68762549f74a0C` | 0.0.10855086 (ownership and the 600,000 FURN team allocation moved from deployer 0.0.4729347: [transferOwnership](https://hashscan.io/testnet/transaction/0x22359a7f3b0e1772b69dbd12fa1fee1f646fad172c0883b61be26aa67eb09ecb), [allocation](https://hashscan.io/testnet/transaction/0x59cba44d252eca4483abd798d9d4ee76c6925a4634cabdb79c34679754325f07)) |

Policy of this engine: daily budget $1.00 (`1e8`), max impact 5% (500 bps), no price ceiling, slippage 3%, fuel reserve 25 HBAR, minimum spend 1 HBAR, scheduled gas 4,000,000, Chainlink HBAR/USD `0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a` with a 25 hour staleness limit.

## 1. Deploy and token creation

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| Deploy | The constructor accepts the SaucerSwap V1 router and the Chainlink feed and reads the factory and WHBAR from the router | 3,400,605 | 2.8565 | [tx](https://hashscan.io/testnet/transaction/0x96520b97239e9c7dd57d947e4b4a199ce0e02ec047db7a419d5fb7fdfe9ea84c) |
| `initialize` with 20 HBAR | The contract creates a finite HTS token, 1,000,000 tokens at 8 decimals, with itself as treasury and sole supply-key holder. 40% is reserved for liquidity, 60% for the team | 232,992 | 12.0827 | [tx](https://hashscan.io/testnet/transaction/0x48a49967751c8b124a53aff0144db7f87b13c86bc5696438767e7ae02cb96218) |

The `initialize` fee is the gas (232,992 x 84 tinybar = 0.1957 HBAR) plus the HTS token creation fee of 1,188,699,027 tinybar (11.887 HBAR). HTS takes that fee from the 20 HBAR the call carried; the rest stays in the engine.

Re-check:

```bash
# the token: finite, the engine is treasury, only the supply key exists
curl -s $M/tokens/$TID | jq '{name,symbol,decimals,supply_type,max_supply,treasury_account_id,supply_key:(.supply_key!=null),admin_key,wipe_key,freeze_key,pause_key,kyc_key,fee_schedule_key}'
# "symbol": "FURN", "decimals": "8", "supply_type": "FINITE", "max_supply": "100000000000000",
# "treasury_account_id": "0.0.10839961", "supply_key": true, every other key null

cast call $E "token()(address)" --rpc-url $RPC        # 0x0000000000000000000000000000000000A567E4
cast call $E "owner()(address)" --rpc-url $RPC        # 0x11Cf661848D52aEdF638658E6b68762549f74a0C

tx 0x48a49967751c8b124a53aff0144db7f87b13c86bc5696438767e7ae02cb96218
# {"timestamp":"1791020384.150886346","gas_used":232992,"result":"SUCCESS","amount":2000000000}
# {"name":"ETHEREUMTRANSACTION","result":"SUCCESS","scheduled":false,"charged_tx_fee":1208270355}

# Initialized(token, totalSupply, liquidityAllocation)
logs "Initialized(address,uint256,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.data)"' |
  while read ts d; do echo "$ts $(cast abi-decode 'f()(uint256,uint256)' $d | n | tr '\n' ' ')"; done
# 1791020384.150886346 100000000000000 40000000000000
```

The deploy transaction reads 3,400,605 gas on the mirror node and 3,401,629 in the JSON-RPC receipt; the fee column is the mirror node's `charged_tx_fee`.

## 2. Pair creation and liquidity

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| `createPool` with 20.95 HBAR | The engine pays SaucerSwap's tinycent pair fee converted through 0x168: 1,995,165,050 tinybar (19.95 HBAR), creates the pair and associates itself with the LP token | 6,622,028 | 17.4494 | [tx](https://hashscan.io/testnet/transaction/0xc0d1579ca2a712d4e7aac065f76e62387f86434c210ee838e960f221994a486e) |
| `seedLiquidity` with 25 HBAR | 400,000 FURN and 25 HBAR go into the pool; the LP tokens are minted to the engine | 993,009 | 0.8341 | [tx](https://hashscan.io/testnet/transaction/0x4b7dc30f8d6d20227bf7ce07e30ee97c289999153e2a27f78fcdc5845a339903) |

The `createPool` fee is 6,622,028 gas x 84 tinybar (5.5625 HBAR) plus the same 1,188,699,027 tinybar HTS creation fee, here for the pair's LP token.

Re-check:

```bash
# PoolCreated(pair, lpToken, feeTinybar) and LiquiditySeeded(tokenAmount, hbarAmount, lpMinted)
logs "PoolCreated(address,address,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.topics[1]) \(.topics[2]) \(.data)"'
# 1791020396.944049104 0x...2989b5a6c8856143ea04898757f360239553cf05 0x...a567e8 0x...76ebcd7a   (0x76ebcd7a = 1995165050)
logs "LiquiditySeeded(uint256,uint256,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.data)"' |
  while read ts d; do echo "$ts $(cast abi-decode 'f()(uint256,uint256,uint256)' $d | n | tr '\n' ' ')"; done
# 1791020412.303908500 40000000000000 2500000000 316227765016

cast call $PAIR "token0()(address)" --rpc-url $RPC    # 0x...3aD2, WHBAR sorts first
cast call $PAIR "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC
# (WHBAR tinybar, FURN raw, timestamp): 2,500,000,000 and 40,000,000,000,000 right after the seed

# the LP position: the engine holds every unit a depositor received, nothing else moves it
cast call $LP "balanceOf(address)(uint256)" $E --rpc-url $RPC | n     # 316227765016
cast call $LP "totalSupply()(uint256)" --rpc-url $RPC | n             # 316227766016
curl -s $M/tokens/0.0.10840040/balances | jq -c '.balances[]|select(.balance>0)'
# {"account":"0.0.10839961","balance":316227765016,"decimals":8}   the engine
# {"account":"0.0.9959","balance":1000,"decimals":8}               the SaucerSwap factory, the pair's first-mint minimum
python3 -c "import math; print(math.isqrt(2500000000*40000000000000)-1000)"   # 316227765016
```

LP minted is `sqrt(2.5e9 x 4e13) - 1000`. The 1,000 units are the minimum liquidity the pair keeps at its first mint and sit at the factory 0.0.9959. The engine's LP balance has not changed since the seed, through six burns, because the contract has no function that moves it.

## 3. Revenue and the manual burn

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| Send 35 HBAR | HBAR sent to the engine is revenue; `RevenueReceived(owner, 3500000000)` | 22,491 | 0.0188 | [tx](https://hashscan.io/testnet/transaction/0x3c2f34fbef91cf1274604eb2328791bded4812ded2006acda1af52f2b2332693) |
| `buyback()` by the owner | The engine bought and burned. 131,578,947 tinybar bought 1,994,299,139,566 raw FURN (19,942.99), and `total_supply` fell by exactly that | 361,563 | 0.3037 | [tx](https://hashscan.io/testnet/transaction/0x389b5f7eae1a05bb09d5d6bb7fafa178b53b645dd963e2d565a5bf692bf687fc) |

The spend is the impact cap. Pool reserve `R` was 2,500,000,000 tinybar, and `R x 500 / (10000 - 500)` = 131,578,947. Chainlink read 10,062,165 ($0.10062165), so the USD cost of the buy, rounded up, was 13,239,691 ($0.1324). The worked numbers are in [architecture.md](architecture.md#worked-example-the-manual-burn).

Re-check:

```bash
tx 0x389b5f7eae1a05bb09d5d6bb7fafa178b53b645dd963e2d565a5bf692bf687fc
# {"timestamp":"1791020436.051157977","gas_used":361563,"result":"SUCCESS","amount":0}
# {"name":"ETHEREUMTRANSACTION","result":"SUCCESS","scheduled":false,"charged_tx_fee":30371292}

logs "RevenueReceived(address,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.data)"' | while read ts d; do echo "$ts $(cast to-dec $d)"; done
# 1791020422.674758836 3500000000

# the burn ledger: every Burned event, and how far total supply fell against what the event says it burned
prev=100000000000000
logs "Burned(uint256,uint256,uint256,uint256,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.data)"' > burned.txt
while read ts d; do
  set -- $(cast abi-decode 'f()(uint256,uint256,uint256,uint256,uint256)' $d | n)   # hbarIn burned priceHbar priceUsd supplyAfter
  echo "$ts hbarIn=$1 burned=$2 supplyAfter=$5 fell=$((prev-$5)) $([ $((prev-$5)) = $2 ] && echo MATCH || echo MISMATCH)"
  prev=$5
done < burned.txt
# 1791020436.051157977 hbarIn=131578947 burned=1994299139566 supplyAfter=98005700860434 fell=1994299139566 MATCH
# ... one MATCH line per Burned event; six in all, the last at 1791107076.082884956 supplyAfter=89430152857744
```

## 4. Team allocation

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| Associate the team wallet with FURN (HIP-719) | A recipient must be associated before it can receive an HTS token | 726,488 | 0.6102 | [tx](https://hashscan.io/testnet/transaction/0xf68b309c90133567d424298d126fcba790d7d9f5c512b4c3b4b95410875c1ac0) |
| `claimTeamAllocation` | The 600,000 FURN team allocation moves from the engine to the wallet | 51,231 | 0.0430 | [tx](https://hashscan.io/testnet/transaction/0x37d1f69842df1fadb8cfdd91e11996b9b5a66e7efdc196ab1be0d6a7bf0bca49) |

The burn happened before the claim, while 600,000 FURN of team allocation sat in the same treasury balance the swap delivered into. The burn took exactly the swap's delta and left the allocation whole: the wallet received the full 60,000,000,000,000 raw units afterwards.

Re-check, the supply ledger. Every unit of FURN is either in the pool, in the team wallet or burned, and the engine holds none:

```bash
cast call $FURN "balanceOf(address)(uint256)" $OWNER --rpc-url $RPC | n   # 60000000000000
cast call $FURN "balanceOf(address)(uint256)" $E --rpc-url $RPC | n       # 0
cast call $E "teamUnclaimed()(uint256)" --rpc-url $RPC | n                # 0
cast call $E "liquidityUnseeded()(uint256)" --rpc-url $RPC | n            # 0
curl -s $M/tokens/$TID/balances | jq -c '[.balances[]|select(.balance>0)|{a:.account,b:.balance}]'
# [{"a":"0.0.10855086","b":60000000000000},{"a":"0.0.10840039","b":29430152857744}]   read after the sixth burn
curl -s $M/tokens/$TID | jq -r .total_supply                               # 89430152857744 = 29430152857744 + 60000000000000
cast call $E "totalBurned()(uint256)" --rpc-url $RPC | n                  # 10569847142256 = 100000000000000 - 89430152857744
```

## 5. The network-triggered burn

`startAutomation(180)` booked schedule 0.0.10840049 for consensus second 1791020653. No transaction of ours was sent after it. Hedera executed the schedule and the engine, as payer, bought and burned.

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| `startAutomation(180)` | The engine booked its first schedule through the Schedule Service at 0x16b: `RunBooked` and `AutomationStarted(180)` | 1,509,024 | 1.2675 | [tx](https://hashscan.io/testnet/transaction/0x57a27cda47b5c8507a0f667c33cb28a6fe3158c4542595bb47a49b1974b06071) |
| The scheduled run, consensus 1791020653.144458104 | A `CONTRACTCALL` with `scheduled: true`, paid by the engine, booked its successor, bought 1,894,868,416,787 raw FURN (18,948.68) for 138,504,155 tinybar and burned it | n/a | 1.4179 | [tx](https://hashscan.io/testnet/transaction/1791020653.144458104) |

Supply before and after: `total_supply` 98,005,700,860,434 to 96,110,832,443,647, a fall of exactly the 1,894,868,416,787 burned.

The engine's balance fell by 280,298,591 tinybar in that one execution: 141,794,436 of network fee (to the fee collector 0.0.802) and 138,504,155 of swap value (to the WHBAR contract 0.0.15057). The impact cap on the reserve of 2,631,578,947 tinybar left by the manual burn is 138,504,155, the amount spent.

Re-check:

```bash
curl -s "$M/transactions?timestamp=1791020653.144458104" |
  jq -c '.transactions[0]|{name,result,scheduled,charged_tx_fee,transaction_id,entity_id,transfers:[.transfers[]|{account,amount}]}'
# {"name":"CONTRACTCALL","result":"SUCCESS","scheduled":true,"charged_tx_fee":141794436,
#  "transaction_id":"0.0.7314364-1791020468-308070712","entity_id":"0.0.10839961",
#  "transfers":[{"account":"0.0.802","amount":141794436},{"account":"0.0.15057","amount":138504155},{"account":"0.0.10839961","amount":-280298591}]}

# the contract-result endpoint does not list a scheduled execution; /transactions and the logs do
curl -s "$M/contracts/$EID/results?timestamp=1791020653.144458104" | jq '.results|length'     # 0

# the logs of that single transaction, in order: book first, then buy and burn, then report
curl -s "$M/contracts/$EID/results/logs?order=asc&timestamp=1791020653.144458104" |
  jq -r '.logs[]|"\(.index) \(.topics[0][0:10])"'
# 0 0x08157f4d   RunBooked
# 9 0xe6d083b0   Burned
# 10 0x27b49ad4  ScheduledRun
cast keccak "RunBooked(address,uint256)" | cut -c1-10                                  # 0x08157f4d
cast keccak "Burned(uint256,uint256,uint256,uint256,uint256)" | cut -c1-10             # 0xe6d083b0
cast keccak "ScheduledRun(uint256)" | cut -c1-10                                       # 0x27b49ad4

# exactly one SCHEDULECREATE child in that execution (one booking per run)
curl -s "$M/transactions?timestamp=gte:1791020653.144458104&timestamp=lte:1791020653.144458200" |
  jq '[.transactions[]|select(.name=="SCHEDULECREATE")]|length'                           # 1

# the schedule that ran, and the successor it booked (deleted by stopAutomation before it fired)
curl -s $M/schedules/0.0.10840049 | jq -c '{schedule_id,executed_timestamp,deleted}'     # executed 1791020653.144458104
curl -s $M/schedules/0.0.10840089 | jq -c '{schedule_id,executed_timestamp,deleted}'     # executed null, deleted true
```

## 6. Automation left running

| Step | What it proves | Gas | Fee charged (HBAR) | Link |
| --- | --- | --- | --- | --- |
| `stopAutomation` | Deletes the pending 180 second schedule and zeroes `nextRunAt` | 99,514 | 0.0835 | [tx](https://hashscan.io/testnet/transaction/0x5530cbe0a3524ee261f3201ee1cf34ad54a341fab620f220c3baffe07d743636) |
| `startAutomation(21600)` | Arms the 6 hour cadence: schedule 0.0.10840094 for consensus second 1791042280 | 1,509,036 | 1.2675 | [tx](https://hashscan.io/testnet/transaction/0xb102a646368bcfca89e1f989a7a791b36cd165c770a25b8d56464d210c7ea8d8) |

### The schedule since

The 6 hour schedule has executed on its own four times since. Every `Burned` event is checked against the supply it left behind by the ledger loop in section 3:

| Consensus timestamp | Spend (tinybar) | FURN burned (raw) | `total_supply` after | Network fee (tinybar) | Link |
| --- | --- | --- | --- | --- | --- |
| 1791020436.051157977 (manual) | 131,578,947 | 1,994,299,139,566 | 98,005,700,860,434 | n/a | [tx](https://hashscan.io/testnet/transaction/0x389b5f7eae1a05bb09d5d6bb7fafa178b53b645dd963e2d565a5bf692bf687fc) |
| 1791020653.144458104 (180 s schedule) | 138,504,155 | 1,894,868,416,787 | 96,110,832,443,647 | 141,794,436 | [tx](https://hashscan.io/testnet/transaction/1791020653.144458104) |
| 1791042280.004353208 (6 h schedule) | 145,793,847 | 1,800,395,051,016 | 94,310,437,392,631 | 140,106,407 | [tx](https://hashscan.io/testnet/transaction/1791042280.004353208) |
| 1791063880.037958663 (6 h schedule) | 153,467,207 | 1,710,631,889,888 | 92,599,805,502,743 | 140,106,407 | [tx](https://hashscan.io/testnet/transaction/1791063880.037958663) |
| 1791085478.123850208 (6 h schedule) | 161,544,429 | 1,625,344,103,411 | 90,974,461,399,332 | 140,106,407 | [tx](https://hashscan.io/testnet/transaction/1791085478.123850208) |
| 1791107076.082884956 (6 h schedule) | 170,046,767 | 1,544,308,541,588 | 89,430,152,857,744 | 140,356,237 | [tx](https://hashscan.io/testnet/transaction/1791107076.082884956) |

Each spend is the impact cap on the reserve the previous burn left: `2,631,578,947 x 500 / 9500` = 138,504,155 for the second burn, `2,770,083,102 x 500 / 9500` = 145,793,847 for the third, `2,915,876,949 x 500 / 9500` = 153,467,207 for the fourth. The fifth and sixth burns spent 161,544,429 and 170,046,767 by the same formula on the reserves their predecessors left.

Re-check:

```bash
# RunBooked chain: each execution booked the next, six hours apart
logs "RunBooked(address,uint256)" | jq -r '.logs[]|"\(.timestamp) \(.topics[1]) \(.data)"' |
  while read ts a d; do echo "$ts schedule=0.0.$((16#${a: -8})) expiry=$((16#${d: -8}))"; done
# 1791020475.051052107 schedule=0.0.10840049 expiry=1791020653
# 1791020653.144458104 schedule=0.0.10840089 expiry=1791020831
# 1791020680.071202004 schedule=0.0.10840094 expiry=1791042280
# 1791042280.004353208 schedule=0.0.10843984 expiry=1791063880
# 1791063880.037958663 schedule=0.0.10847706 expiry=1791085478
# ... one RunBooked per later execution; the latest read is expiry=1791128675

for ts in 1791042280.004353208 1791063880.037958663 1791085478.123850208 1791107076.082884956; do
  curl -s "$M/transactions?timestamp=$ts" | jq -c '.transactions[0]|{name,result,scheduled,charged_tx_fee}'
done
# {"name":"CONTRACTCALL","result":"SUCCESS","scheduled":true,"charged_tx_fee":140106407}  (the first three; the sixth burn charged 140356237)

cast call $E "runInterval()(uint256)" --rpc-url $RPC | n        # 21600
cast call $E "nextRunAt()(uint256)" --rpc-url $RPC | n           # 1791128675 when read (2026-10-04 14:29 UTC); later reads show a later run
cast call $E "pendingSchedule()(address)" --rpc-url $RPC         # the schedule booked for nextRunAt
cast call $E "totalBurned()(uint256)" --rpc-url $RPC | n         # 10569847142256 when read; only ever rises
cast call $E "totalSpentHbar()(uint256)" --rpc-url $RPC | n      # 900935352 = 131578947 + 138504155 + 145793847 + 153467207 + 161544429 + 170046767
cast balance $E --rpc-url $RPC --ether                           # 29.07653979 HBAR when read
```

The ledger totals above move with every later run: `totalBurned()` only rises, `total_supply` only falls, and the loop in section 3 keeps printing MATCH for each new `Burned` event. Widen `S` and `U` (at most 7 days apart) to read later windows.

## 7. Policy and state on chain

```bash
for f in dailyBudgetUsd maxImpactBps priceCeilingUsd slippageBps fuelReserve minSpend scheduledGas maxOracleAge; do
  printf '%s ' $f; cast call $E "$f()(uint256)" --rpc-url $RPC | n
done
# dailyBudgetUsd 100000000    maxImpactBps 500    priceCeilingUsd 0    slippageBps 300
# fuelReserve 2500000000      minSpend 100000000  scheduledGas 4000000 maxOracleAge 90000

cast call $E "previewBuyback()(uint8,uint256)" --rpc-url $RPC    # skip reason (0 = would spend), tinybar it would spend now
cast call $E "hbarUsd()(uint256)" --rpc-url $RPC | n             # Chainlink HBAR/USD, 8 decimals
cast call $E "status()((address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256))" --rpc-url $RPC
```

`previewBuyback()` is the same `_plan()` the scheduled run reads, so the number it prints is what the next run would spend if it ran now.
