#!/usr/bin/env bash
# Re-reads every headline claim of docs/testnet-evidence.md from the chain and prints PASS or FAIL per row.
# Exits 1 when any row fails. Needs curl, jq and cast. Reads only public endpoints, no key, no .env.
#
#   bash scripts/verify-evidence.sh
#   MIN_SCHEDULED_BURNS=7 bash scripts/verify-evidence.sh   # every expectation is an env override
#
# Engine v2 (the canonical deployment) gets the full set of rows plus its policy and its two refusals. Engine v1, the
# earlier deployment that keeps running on its own schedule, gets the same chain-state rows.
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${HEDERA_RPC_URL:-https://testnet.hashio.io/api}
M=https://testnet.mirrornode.hedera.com/api/v1
SOURCIFY=https://sourcify.dev/server/v2/contract/296

# Engine v2
E2=0x8B674665F2b8B7e5220D5F8e466a4B0eB982Db25 # FurnaceEngine v2
T2ID=0.0.10860071                              # FURN of v2, created by the engine
EXPECT_CODE_BYTES=${EXPECT_CODE_BYTES:-17314}
MIN_SCHEDULED_BURNS=${MIN_SCHEDULED_BURNS:-3}
EXPECT_LOT=${EXPECT_LOT:-30000000}  # $0.30, 8 decimals
EXPECT_GAP=${EXPECT_GAP:-900}
EXPECT_DEV=${EXPECT_DEV:-500}

# Engine v1
E1=0x706947eCC0411bAdeF790282bb89b80126357D9D # FurnaceEngine v1, contract 0.0.10839961
E1ID=0.0.10839961
T1ID=0.0.10840036
V1_CODE_BYTES=${V1_CODE_BYTES:-14877}
V1_MIN_SCHEDULED_BURNS=${V1_MIN_SCHEDULED_BURNS:-5}

EXPECT_OWNER=${EXPECT_OWNER:-0x11Cf661848D52aEdF638658E6b68762549f74a0C}
EXPECT_INITIAL_SUPPLY=${EXPECT_INITIAL_SUPPLY:-100000000000000} # 1,000,000 FURN at 8 decimals

fails=0
row() { # row <name> <ok 0|1> <detail>
  if [ "$2" = 0 ]; then printf 'PASS  %-42s %s\n' "$1" "$3"; else printf 'FAIL  %-42s %s\n' "$1" "$3"; fails=$((fails + 1)); fi
}
num() { awk '{print $1}'; } # cast prints "123 [1.23e2]"; keep the exact value
lower() { tr '[:upper:]' '[:lower:]'; }

# every log of a contract, following the mirror's pagination (a topic filter would cap the window at 7 days)
all_logs() {
  local url="$M/contracts/$1/results/logs?order=asc&limit=100" i page next
  for i in $(seq 1 40); do
    page=$(curl -sf "$url") || return 1
    jq -c '.logs[]' <<<"$page"
    next=$(jq -r '.links.next // empty' <<<"$page")
    [ -n "$next" ] || return 0
    url="https://testnet.mirrornode.hedera.com$next"
  done
}

# rows for one engine: bytecode, owner, token, supply, burns, Sourcify. Leaves the engine's logs in $LOGS.
verify_engine() { # verify_engine <label> <address> <contract id> <token id> <code bytes> <min scheduled burns>
  local label=$1 E=$2 EID=$3 TID=$4 want_bytes=$5 want_sched=$6
  local code bytes owner tok sym kind treasury maxsup supply tokaddr evm_supply burned
  code=$(cast code "$E" --rpc-url "$RPC" 2>/dev/null)
  bytes=$(((${#code} - 2) / 2))
  [ "${#code}" -gt 2 ] && [ "$bytes" = "$want_bytes" ]
  row "$label engine bytecode" $? "$bytes bytes at $E (want $want_bytes)"

  owner=$(cast call "$E" "owner()(address)" --rpc-url "$RPC" 2>/dev/null)
  [ -n "$owner" ] && [ "$(lower <<<"$owner")" = "$(lower <<<"$EXPECT_OWNER")" ]
  row "$label engine owner" $? "owner() = $owner (want $EXPECT_OWNER)"

  tok=$(curl -sf "$M/tokens/$TID")
  sym=$(jq -r .symbol <<<"$tok")
  kind=$(jq -r .supply_type <<<"$tok")
  treasury=$(jq -r .treasury_account_id <<<"$tok")
  maxsup=$(jq -r .max_supply <<<"$tok")
  supply=$(jq -r .total_supply <<<"$tok")
  tokaddr=$(cast call "$E" "token()(address)" --rpc-url "$RPC" 2>/dev/null)
  evm_supply=$(cast call "$tokaddr" "totalSupply()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
  burned=$(cast call "$E" "totalBurned()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
  [ "$sym" = FURN ] && [ "$kind" = FINITE ] && [ "$treasury" = "$EID" ] && [ "$maxsup" = "$EXPECT_INITIAL_SUPPLY" ]
  row "$label FURN: finite, treasury = engine" $? "$sym $kind max_supply=$maxsup treasury=$treasury (want $EXPECT_INITIAL_SUPPLY, $EID)"
  [ -n "$burned" ] && [ "$burned" -gt 0 ] && [ "$supply" = "$evm_supply" ] && [ "$supply" = "$((EXPECT_INITIAL_SUPPLY - burned))" ]
  row "$label FURN supply = initial - burned" $? "mirror=$supply evm=$evm_supply initial=$EXPECT_INITIAL_SUPPLY totalBurned()=$burned"

  # every Burned log, split by whether the transaction that emitted it is flagged scheduled
  LOGS=$(all_logs "$EID")
  local burns total=0 scheduled=0 manual=0 bad=0 sum=0 last_after= ts data w t
  burns=$(jq -r --arg t "$(cast keccak 'Burned(uint256,uint256,uint256,uint256,uint256)')" 'select(.topics[0]==$t)|"\(.timestamp) \(.data)"' <<<"$LOGS")
  while read -r ts data; do
    [ -n "$ts" ] || continue
    total=$((total + 1))
    w=${data#0x}
    sum=$((sum + $(cast to-dec "0x${w:64:64}")))
    last_after=$(cast to-dec "0x${w:256:64}")
    t=$(curl -sf "$M/transactions?timestamp=$ts" | jq -r '.transactions[0]|"\(.scheduled) \(.result)"')
    case "$t" in
      "true SUCCESS") scheduled=$((scheduled + 1)) ;;
      "false SUCCESS") manual=$((manual + 1)) ;;
      *) bad=$((bad + 1)) ;;
    esac
  done <<<"$burns"
  [ "$total" -gt 0 ] && [ "$bad" = 0 ] && [ "$scheduled" -ge "$want_sched" ]
  row "$label scheduled burns, scheduled=true" $? "$scheduled scheduled + $manual manual of $total Burned logs, $bad failed (want >= $want_sched scheduled)"
  [ "$sum" = "$burned" ] && [ "$last_after" = "$supply" ]
  row "$label Burned logs add up to the supply" $? "sum(tokensBurned)=$sum totalBurned()=$burned, last supplyAfter=$last_after supply=$supply"

  local sm
  sm=$(curl -sf -A "verify-evidence.sh" "$SOURCIFY/$E" | jq -r '.match // "none"')
  [ "$sm" = exact_match ] || [ "$sm" = match ]
  row "$label Sourcify match, engine" $? "match = $sm (exact_match or match passes)"
}

E2ID=$(curl -sf "$M/contracts/$E2" | jq -r .contract_id)

verify_engine v2 "$E2" "$E2ID" "$T2ID" "$EXPECT_CODE_BYTES" "$MIN_SCHEDULED_BURNS"
V2_LOGS=$LOGS

# v2 policy, read from the chain
lot=$(cast call "$E2" "maxLotUsd()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
gap=$(cast call "$E2" "minGapSeconds()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
dev=$(cast call "$E2" "maxTwapDeviationBps()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
[ "$lot" = "$EXPECT_LOT" ] && [ "$gap" = "$EXPECT_GAP" ] && [ "$dev" = "$EXPECT_DEV" ]
row "v2 policy: lot, gap, price bound" $? "maxLotUsd=$lot minGapSeconds=$gap maxTwapDeviationBps=$dev (want $EXPECT_LOT, $EXPECT_GAP, $EXPECT_DEV)"

# v2 refusals: a BuybackSkipped log with the reason, in a successful transaction that burned nothing.
skip_topic=$(cast keccak 'BuybackSkipped(uint8)')
burn_topic=$(cast keccak 'Burned(uint256,uint256,uint256,uint256,uint256)')
refusal() { # refusal <name> <reason number>
  local name=$1 reason=$2 hits=0 ok=0 ts data tx hash burned_in_tx
  while read -r ts data; do
    [ -n "$ts" ] || continue
    [ "$(cast to-dec "$data")" = "$reason" ] || continue
    hits=$((hits + 1))
    tx=$(curl -sf "$M/transactions?timestamp=$ts" | jq -r '.transactions[0]|"\(.result) \(.transaction_id)"')
    burned_in_tx=$(jq -r --arg ts "$ts" --arg t "$burn_topic" 'select(.timestamp==$ts and .topics[0]==$t)|1' <<<"$V2_LOGS" | wc -l | tr -d ' ')
    [ "${tx%% *}" = SUCCESS ] && [ "$burned_in_tx" = 0 ] && ok=$((ok + 1))
  done < <(jq -r --arg t "$skip_topic" 'select(.topics[0]==$t)|"\(.timestamp) \(.data)"' <<<"$V2_LOGS")
  [ "$hits" -gt 0 ] && [ "$ok" = "$hits" ]
  row "v2 refusal $name, nothing burned" $? "$ok of $hits BuybackSkipped($name) logs are successful transactions with no Burned log"
}
refusal TooSoon 6
refusal TwapDeviation 10

verify_engine v1 "$E1" "$E1ID" "$T1ID" "$V1_CODE_BYTES" "$V1_MIN_SCHEDULED_BURNS"

echo
if [ "$fails" = 0 ]; then echo "ALL ROWS PASS"; else echo "$fails ROW(S) FAILED"; fi
[ "$fails" = 0 ]
