#!/usr/bin/env bash
# Runs the whole Furnace loop once on Hedera testnet and prints a HashScan link, the gas and the HBAR fee for every
# transaction: deploy, create the HTS token, create the SaucerSwap V1 pool, seed it, fund revenue (fuel as a plain
# transfer, the rest tagged with its source), a manual burn, a second buy refused inside the minimum gap, the team allocation claim, a burn the network triggers from the engine's own
# schedule, a buy refused because the pool was moved right before it (spot above the engine's own average price), and
# the schedule left running.
#
#   DEPLOYER_PRIVATE_KEY=0x... in packages/foundry/.env (ECDSA, funded from https://portal.hedera.com/faucet)
#   yarn foundry:live              # deploys a fresh engine
#   ENGINE=0x... yarn foundry:live # reuses a deployed engine (skips deploy, initialize, pool and seed when done)
#
# Sizes (whole HBAR unless noted), override from the environment:
#   TOKEN_SUPPLY=1000000 DECIMALS=8 LIQUIDITY_PCT=40  the token the engine creates
#   SEED_HBAR=100       HBAR paired with the liquidity allocation
#   FUEL_HBAR=25        plain transfer to the engine; FUEL_RESERVE_HBAR of the balance is never spent on buybacks
#   TAGGED_HBAR=40      revenue sent through depositRevenue("swap-fees"), so the event carries its source
#   TEST_INTERVAL=2100  seconds for the run the network triggers during this script
#   FINAL_INTERVAL=2100 seconds for the schedule left running at the end (the same schedule when equal)
#   PUMP_HBAR=6         HBAR the deployer swaps into the pool right before the buy the average-price bound must refuse
# Policy of the deployed engine (read by script/Deploy.s.sol):
#   DAILY_BUDGET_USD=500000000 MAX_LOT_USD=30000000 MIN_GAP_SECONDS=900 MAX_TWAP_DEV_BPS=500
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in packages/foundry/.env}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

RPC=${FURNACE_RPC_URL:-${HEDERA_RPC_URL:-https://testnet.hashio.io/api}}
MIRROR=${MIRROR_URL:-https://testnet.mirrornode.hedera.com/api/v1}
TOKEN_SUPPLY=${TOKEN_SUPPLY:-1000000}
DECIMALS=${DECIMALS:-8}
LIQUIDITY_PCT=${LIQUIDITY_PCT:-40}
SEED_HBAR=${SEED_HBAR:-100}
FUEL_HBAR=${FUEL_HBAR:-25}
TAGGED_HBAR=${TAGGED_HBAR:-40}
TEST_INTERVAL=${TEST_INTERVAL:-2100}
FINAL_INTERVAL=${FINAL_INTERVAL:-2100}
PUMP_HBAR=${PUMP_HBAR:-6}
export DAILY_BUDGET_USD=${DAILY_BUDGET_USD:-500000000} MAX_LOT_USD=${MAX_LOT_USD:-30000000}
export MIN_GAP_SECONDS=${MIN_GAP_SECONDS:-900} MAX_TWAP_DEV_BPS=${MAX_TWAP_DEV_BPS:-500}
ME=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
START_BALANCE=$(cast balance "$ME" --rpc-url "$RPC" --ether)

# cast prints "123 [1.23e2]"; keep the exact value.
num() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }

send() {
  local label=$1
  shift
  local out status hash gas price
  out=$(cast send --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --legacy --json "$@")
  status=$(jq -r .status <<<"$out")
  hash=$(jq -r .transactionHash <<<"$out")
  gas=$(printf '%d' "$(jq -r .gasUsed <<<"$out")")
  price=$(printf '%d' "$(jq -r .effectiveGasPrice <<<"$out")")
  printf '%-30s %s  gas=%d  fee=%s HBAR  https://hashscan.io/testnet/transaction/%s\n' \
    "$label" "$([ "$status" = 0x1 ] && echo OK || echo FAILED)" "$gas" \
    "$(echo "scale=4; $gas * $price / 10^18" | bc)" "$hash"
  [ "$status" = 0x1 ] || exit 1
}

supply() { curl -s "$MIRROR/tokens/$(printf '0.0.%d' "$TOKEN")" | jq -r .total_supply; }

# The mirror node trails consensus by a few seconds; wait until the supply it serves stops changing.
settled_supply() {
  local prev cur
  prev=$(supply)
  for _ in 1 2 3 4 5 6; do
    sleep 5
    cur=$(supply)
    [ "$cur" = "$prev" ] && break
    prev=$cur
  done
  echo "$prev"
}

# Consensus time as the chain reports it.
now() { cast block latest --rpc-url "$RPC" -f timestamp | awk '{print $1}'; }

# Waits until the chain clock reaches second $1.
wait_until() {
  local target=$1
  local ticks=0
  while [ "$(now)" -lt "$target" ]; do
    sleep 5
    ticks=$((ticks + 1))
    [ $((ticks % 60)) -eq 0 ] && echo "  ... waiting for chain time $target (now $(now))"
  done
  return 0
}

# The BuybackSkipped reason (data word of the log) in the receipt of the last transaction; empty when none.
SKIP_TOPIC=$(cast keccak "BuybackSkipped(uint8)")
skip_reason() {
  local out=$1
  jq -r --arg t "$SKIP_TOPIC" '[.logs[]|select(.topics[0]==$t)|.data][0] // empty' <<<"$out" | xargs -I{} cast to-dec {}
}

# Like send, but returns the receipt JSON in $RECEIPT for the caller to read events from.
send_receipt() {
  local label=$1
  shift
  RECEIPT=$(cast send --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --legacy --json "$@")
  local status hash
  status=$(jq -r .status <<<"$RECEIPT")
  hash=$(jq -r .transactionHash <<<"$RECEIPT")
  printf '%-30s %s  https://hashscan.io/testnet/transaction/%s\n' "$label" "$([ "$status" = 0x1 ] && echo OK || echo FAILED)" "$hash"
  [ "$status" = 0x1 ] || exit 1
}

echo "Deployer $ME, $START_BALANCE HBAR"

if [ -z "${ENGINE:-}" ]; then
  mkdir -p deployments
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow --legacy >/dev/null
  node scripts-js/generateTsAbis.js >/dev/null
  ENGINE=$(jq -r '[to_entries[] | select(.value == "FurnaceEngine") | .key] | last' deployments/296.json)
  echo "Deployed FurnaceEngine $ENGINE  https://hashscan.io/testnet/contract/$ENGINE"
fi

RAW_SUPPLY=$((TOKEN_SUPPLY * 10 ** DECIMALS))
RAW_LIQ=$((RAW_SUPPLY * LIQUIDITY_PCT / 100))

if [ "$(cast call "$ENGINE" "token()(address)" --rpc-url "$RPC")" = 0x0000000000000000000000000000000000000000 ]; then
  # The HTS creation fee comes out of the value sent; what it does not take stays in the engine.
  send "initialize (HTS token)" "$ENGINE" "initialize(string,string,uint64,uint8,uint64)" \
    "Furnace Demo" "FURN" "$RAW_SUPPLY" "$DECIMALS" "$RAW_LIQ" --value 20ether --gas-limit 3000000
fi
TOKEN=$(cast call "$ENGINE" "token()(address)" --rpc-url "$RPC")
TOKEN_ID=$(printf '0.0.%d' "$TOKEN")
echo "Token $TOKEN_ID  https://hashscan.io/testnet/token/$TOKEN_ID"
echo "Mirror: $(curl -s "$MIRROR/tokens/$TOKEN_ID" | jq -c '{total_supply,max_supply,supply_type,treasury_account_id,admin_key,wipe_key,freeze_key}')"

if [ "$(cast call "$ENGINE" "pair()(address)" --rpc-url "$RPC")" = 0x0000000000000000000000000000000000000000 ]; then
  FEE=$(num "$ENGINE" "poolCreationFee()(uint256)")
  # tinybar to the weibar the JSON-RPC layer takes, plus 5% for a moving exchange rate; the excess stays in the engine.
  FEE_WEI=$(echo "$FEE * 10000000000 * 105 / 100" | bc)
  echo "Pool creation fee $FEE tinybar (SaucerSwap tinycent fee through the 0x168 exchange rate)"
  # createPair associates both tokens inside the call and needs about 6.6M gas.
  send "createPool (SaucerSwap V1)" "$ENGINE" "createPool()" --value "$FEE_WEI" --gas-limit 10000000
fi
PAIR=$(cast call "$ENGINE" "pair()(address)" --rpc-url "$RPC")
LP=$(cast call "$ENGINE" "lpToken()(address)" --rpc-url "$RPC")
echo "Pair $PAIR  https://hashscan.io/testnet/contract/$PAIR"
echo "LP token $(printf '0.0.%d' "$LP")  https://hashscan.io/testnet/token/$(printf '0.0.%d' "$LP")"

if [ "$(num "$ENGINE" "liquidityUnseeded()(uint256)")" != 0 ]; then
  send "seedLiquidity ${SEED_HBAR} HBAR" "$ENGINE" "seedLiquidity(uint256,uint256)" 0 0 \
    --value "${SEED_HBAR}ether" --gas-limit 4000000
fi
echo "Reserves (WHBAR first if it sorts first): $(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | tr '\n' ' ')"
echo "LP held by engine: $(num "$LP" "balanceOf(address)(uint256)" "$ENGINE")"

if [ "$(num "$ENGINE" "totalBurned()(uint256)")" = 0 ]; then
  send "fund ${FUEL_HBAR} HBAR (plain transfer)" "$ENGINE" --value "${FUEL_HBAR}ether" --gas-limit 200000
  send "depositRevenue swap-fees ${TAGGED_HBAR}" "$ENGINE" "depositRevenue(bytes32)" "$(cast format-bytes32-string swap-fees)" \
    --value "${TAGGED_HBAR}ether" --gas-limit 300000
  # The engine took its first price snapshot when it seeded the pool; an average needs MIN_TWAP_WINDOW seconds.
  wait_until $(($(num "$ENGINE" "twapAt()(uint256)") + $(num "$ENGINE" "MIN_TWAP_WINDOW()(uint256)") + 5))
  echo "Plan: $(cast call "$ENGINE" "previewBuyback()(uint8,uint256)" --rpc-url "$RPC" | tr '\n' ' ') (skip reason, tinybar to spend)"
  SUPPLY_BEFORE=$(settled_supply)
  echo "Mirror total_supply before manual burn: $SUPPLY_BEFORE"
  send "buyback (manual burn)" "$ENGINE" "buyback()" --gas-limit 1500000
  SUPPLY_AFTER=$(settled_supply)
  echo "Mirror total_supply after manual burn:  $SUPPLY_AFTER  (fell by $((SUPPLY_BEFORE - SUPPLY_AFTER)); engine totalBurned $(num "$ENGINE" "totalBurned()(uint256)"))"

  # A second buy right behind the first is inside the minimum gap: the engine records a skip and spends nothing.
  BURNED_BEFORE_GAP=$(num "$ENGINE" "totalBurned()(uint256)")
  send_receipt "buyback inside the gap" "$ENGINE" "buyback()" --gas-limit 1500000
  echo "BuybackSkipped reason $(skip_reason "$RECEIPT") (6 = TooSoon); totalBurned $BURNED_BEFORE_GAP -> $(num "$ENGINE" "totalBurned()(uint256)")"
  [ "$(skip_reason "$RECEIPT")" = 6 ] && [ "$(num "$ENGINE" "totalBurned()(uint256)")" = "$BURNED_BEFORE_GAP" ] || {
    echo "FAILED: the second buy should have been skipped as TooSoon"
    exit 1
  }
fi

if [ "$(num "$ENGINE" "teamUnclaimed()(uint256)")" != 0 ]; then
  send "associate team wallet with token" "$TOKEN" "associate()" --gas-limit 1000000
  send "claimTeamAllocation" "$ENGINE" "claimTeamAllocation(address)" "$ME" --gas-limit 1000000
  echo "Team wallet holds $(num "$TOKEN" "balanceOf(address)(uint256)" "$ME") raw units"
fi

BURNED_BEFORE_SCHEDULE=$(num "$ENGINE" "totalBurned()(uint256)")
if [ "$(num "$ENGINE" "runInterval()(uint256)")" != 0 ]; then
  send "stopAutomation" "$ENGINE" "stopAutomation()" --gas-limit 1000000
fi
send "startAutomation ${TEST_INTERVAL}s" "$ENGINE" "startAutomation(uint256)" "$TEST_INTERVAL" --gas-limit 4000000
NEXT=$(num "$ENGINE" "nextRunAt()(uint256)")
echo "Run booked for $NEXT, schedule $(cast call "$ENGINE" "pendingSchedule()(address)" --rpc-url "$RPC")"
# Anyone may re-book a schedule that has died, but never a live one.
REARM_OUT=$(cast call "$ENGINE" "rearm()" --rpc-url "$RPC" 2>&1 || true)
if grep -qi "$(cast sig 'ScheduleLive(uint256)' | sed 's/^0x//')" <<<"$REARM_OUT"; then
  echo "rearm() while the schedule is live reverts ScheduleLive"
else
  echo "FAILED: rearm() on a live schedule did not revert ScheduleLive: $REARM_OUT"
  exit 1
fi
SUPPLY_BEFORE=$(settled_supply)
echo "Mirror total_supply before the network-triggered run: $SUPPLY_BEFORE"

echo "Waiting for the network to run it..."
deadline=$((NEXT + 240))
ticks=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  [ "$(num "$ENGINE" "nextRunAt()(uint256)")" != "$NEXT" ] && break
  ticks=$((ticks + 1))
  [ $((ticks % 16)) -eq 0 ] && echo "  ... waiting for the scheduled run at $NEXT (now $(date +%s))"
done
[ "$(num "$ENGINE" "nextRunAt()(uint256)")" != "$NEXT" ] || {
  echo "FAILED: no scheduled run by $deadline"
  exit 1
}
echo "Scheduled run executed; successor booked for $(num "$ENGINE" "nextRunAt()(uint256)")"
curl -s "$MIRROR/contracts/$ENGINE/results?order=desc&limit=3" |
  jq -r '.results[] | "  \(.result)  from=\(.from)  gas_used=\(.gas_used)  consensus=\(.timestamp)  https://hashscan.io/testnet/transaction/\(.timestamp)"'
BURNED_AFTER_SCHEDULE=$(num "$ENGINE" "totalBurned()(uint256)")
SUPPLY_AFTER=$(settled_supply)
echo "Mirror total_supply after the network-triggered run: $SUPPLY_AFTER  (fell by $((SUPPLY_BEFORE - SUPPLY_AFTER)))"
echo "Engine totalBurned $BURNED_BEFORE_SCHEDULE -> $BURNED_AFTER_SCHEDULE"
[ "$BURNED_AFTER_SCHEDULE" -gt "$BURNED_BEFORE_SCHEDULE" ] && [ "$SUPPLY_AFTER" -lt "$SUPPLY_BEFORE" ] || {
  echo "FAILED: the scheduled run did not burn"
  exit 1
}

# The independent price bound. Wait out the minimum gap after the scheduled burn, then the deployer buys the token
# with PUMP_HBAR right before a buyback. The pool's spot price is now far above its average since the engine's last
# snapshot, so the engine records TwapDeviation and spends nothing. The next scheduled run is left to the network.
# The demonstration needs an average at least MIN_TWAP_WINDOW old, and the run after it (which restarts the window)
# needs another full window before the schedule fires, so it goes one minute past the first window.
wait_until $(($(num "$ENGINE" "twapAt()(uint256)") + $(num "$ENGINE" "MIN_TWAP_WINDOW()(uint256)") + 60))
NEXT_RUN=$(num "$ENGINE" "nextRunAt()(uint256)")
if [ "$(now)" -lt "$((NEXT_RUN - $(num "$ENGINE" "MIN_TWAP_WINDOW()(uint256)") - 30))" ]; then
  PATH_ARGS="[$(cast call "$ENGINE" "whbar()(address)" --rpc-url "$RPC"),$TOKEN]"
  ROUTER=$(cast call "$ENGINE" "router()(address)" --rpc-url "$RPC")
  echo "Spot before the swap: $(cast call "$ENGINE" "twap()(uint8,uint256,uint256,uint256)" --rpc-url "$RPC" | tr '\n' ' ') (state, average, window s, deviation bps)"
  send "swap ${PUMP_HBAR} HBAR into the pool" "$ROUTER" "swapExactETHForTokens(uint256,address[],address,uint256)" 0 "$PATH_ARGS" "$ME" "$(($(now) + 300))" \
    --value "${PUMP_HBAR}ether" --gas-limit 1500000
  echo "After the swap: $(cast call "$ENGINE" "twap()(uint8,uint256,uint256,uint256)" --rpc-url "$RPC" | tr '\n' ' ') (state, average, window s, deviation bps); preview $(cast call "$ENGINE" "previewBuyback()(uint8,uint256)" --rpc-url "$RPC" | tr '\n' ' ')"
  BURNED_BEFORE_TWAP=$(num "$ENGINE" "totalBurned()(uint256)")
  BALANCE_BEFORE_TWAP=$(cast balance "$ENGINE" --rpc-url "$RPC")
  send_receipt "buyback after the swap" "$ENGINE" "buyback()" --gas-limit 1500000
  echo "BuybackSkipped reason $(skip_reason "$RECEIPT") (10 = TwapDeviation); totalBurned $BURNED_BEFORE_TWAP -> $(num "$ENGINE" "totalBurned()(uint256)"); engine balance $BALANCE_BEFORE_TWAP -> $(cast balance "$ENGINE" --rpc-url "$RPC")"
  [ "$(skip_reason "$RECEIPT")" = 10 ] && [ "$(num "$ENGINE" "totalBurned()(uint256)")" = "$BURNED_BEFORE_TWAP" ] || {
    echo "FAILED: the buy after the swap should have been refused as TwapDeviation"
    exit 1
  }
else
  echo "Skipped the price-bound demonstration: the next scheduled run is too close for a full average window afterwards"
fi

# Leave the engine running on its schedule.
if [ "$FINAL_INTERVAL" != "$TEST_INTERVAL" ]; then
  send "stopAutomation" "$ENGINE" "stopAutomation()" --gas-limit 1000000
  send "startAutomation ${FINAL_INTERVAL}s" "$ENGINE" "startAutomation(uint256)" "$FINAL_INTERVAL" --gas-limit 4000000
fi
echo "Left running: next run $(num "$ENGINE" "nextRunAt()(uint256)"), schedule $(cast call "$ENGINE" "pendingSchedule()(address)" --rpc-url "$RPC")"
echo "Engine balance $(cast balance "$ENGINE" --rpc-url "$RPC" --ether) HBAR, status:"
cast call "$ENGINE" "status()((address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256))" --rpc-url "$RPC"
echo "Deployer spent $(echo "$START_BALANCE - $(cast balance "$ME" --rpc-url "$RPC" --ether)" | bc) HBAR in this run"
