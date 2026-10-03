#!/usr/bin/env bash
# Runs the whole Furnace loop once on Hedera testnet and prints a HashScan link, the gas and the HBAR fee for every
# transaction: deploy, create the HTS token, create the SaucerSwap V1 pool, seed it, fund revenue, a manual burn, the
# team allocation claim, a burn the network triggers from the engine's own schedule, then a 6 hour schedule left running.
#
#   DEPLOYER_PRIVATE_KEY=0x... in packages/foundry/.env (ECDSA, funded from https://portal.hedera.com/faucet)
#   yarn foundry:live              # deploys a fresh engine
#   ENGINE=0x... yarn foundry:live # reuses a deployed engine (skips deploy, initialize, pool and seed when done)
#
# Sizes (whole HBAR unless noted), override from the environment:
#   TOKEN_SUPPLY=1000000 DECIMALS=8 LIQUIDITY_PCT=40  the token the engine creates
#   SEED_HBAR=25        HBAR paired with the liquidity allocation
#   FUND_HBAR=35        revenue plus fuel sent to the engine (FUEL_RESERVE_HBAR of it is never spent on buybacks)
#   TEST_INTERVAL=180   seconds for the run the network triggers during this script
#   FINAL_INTERVAL=21600 seconds for the schedule left running at the end
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
SEED_HBAR=${SEED_HBAR:-25}
FUND_HBAR=${FUND_HBAR:-35}
TEST_INTERVAL=${TEST_INTERVAL:-180}
FINAL_INTERVAL=${FINAL_INTERVAL:-21600}
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
  send "fund ${FUND_HBAR} HBAR (revenue + fuel)" "$ENGINE" --value "${FUND_HBAR}ether" --gas-limit 200000
  echo "Plan: $(cast call "$ENGINE" "previewBuyback()(uint8,uint256)" --rpc-url "$RPC" | tr '\n' ' ') (skip reason, tinybar to spend)"
  SUPPLY_BEFORE=$(settled_supply)
  echo "Mirror total_supply before manual burn: $SUPPLY_BEFORE"
  send "buyback (manual burn)" "$ENGINE" "buyback()" --gas-limit 1500000
  SUPPLY_AFTER=$(settled_supply)
  echo "Mirror total_supply after manual burn:  $SUPPLY_AFTER  (fell by $((SUPPLY_BEFORE - SUPPLY_AFTER)); engine totalBurned $(num "$ENGINE" "totalBurned()(uint256)"))"
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
SUPPLY_BEFORE=$(settled_supply)
echo "Mirror total_supply before the network-triggered run: $SUPPLY_BEFORE"

echo "Waiting for the network to run it..."
deadline=$((NEXT + 240))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  [ "$(num "$ENGINE" "nextRunAt()(uint256)")" != "$NEXT" ] && break
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

# Leave the engine running on the long schedule.
send "stopAutomation" "$ENGINE" "stopAutomation()" --gas-limit 1000000
send "startAutomation ${FINAL_INTERVAL}s" "$ENGINE" "startAutomation(uint256)" "$FINAL_INTERVAL" --gas-limit 4000000
echo "Left running: next run $(num "$ENGINE" "nextRunAt()(uint256)"), schedule $(cast call "$ENGINE" "pendingSchedule()(address)" --rpc-url "$RPC")"
echo "Engine balance $(cast balance "$ENGINE" --rpc-url "$RPC" --ether) HBAR, status:"
cast call "$ENGINE" "status()((address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256))" --rpc-url "$RPC"
echo "Deployer spent $(echo "$START_BALANCE - $(cast balance "$ME" --rpc-url "$RPC" --ether)" | bc) HBAR in this run"
