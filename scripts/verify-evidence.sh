#!/usr/bin/env bash
# Re-reads every headline claim of docs/testnet-evidence.md from the chain and prints PASS or FAIL per row.
# Exits 1 when any row fails. Needs curl, jq and cast. Reads only public endpoints, no key, no .env.
#
#   bash scripts/verify-evidence.sh
#   EXPECT_OWNER=0x... MIN_SCHEDULED_BURNS=7 bash scripts/verify-evidence.sh   # every expectation is an env override
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${HEDERA_RPC_URL:-https://testnet.hashio.io/api}
M=https://testnet.mirrornode.hedera.com/api/v1
SOURCIFY=https://sourcify.dev/server/v2/contract/296

E=0x706947eCC0411bAdeF790282bb89b80126357D9D # FurnaceEngine, contract 0.0.10839961
EID=0.0.10839961
TID=0.0.10840036 # FURN, created by the engine
EXPECT_OWNER=${EXPECT_OWNER:-0x11Cf661848D52aEdF638658E6b68762549f74a0C}
EXPECT_CODE_BYTES=${EXPECT_CODE_BYTES:-14877}
EXPECT_INITIAL_SUPPLY=${EXPECT_INITIAL_SUPPLY:-100000000000000} # 1,000,000 FURN at 8 decimals
MIN_SCHEDULED_BURNS=${MIN_SCHEDULED_BURNS:-5}

fails=0
row() { # row <name> <ok 0|1> <detail>
  if [ "$2" = 0 ]; then printf 'PASS  %-34s %s\n' "$1" "$3"; else printf 'FAIL  %-34s %s\n' "$1" "$3"; fails=$((fails + 1)); fi
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

# rows 1-2: bytecode and owner
code=$(cast code "$E" --rpc-url "$RPC" 2>/dev/null)
bytes=$(((${#code} - 2) / 2))
[ "${#code}" -gt 2 ] && [ "$bytes" = "$EXPECT_CODE_BYTES" ]
row "engine bytecode" $? "$bytes bytes at $E (want $EXPECT_CODE_BYTES)"

owner=$(cast call "$E" "owner()(address)" --rpc-url "$RPC" 2>/dev/null)
[ -n "$owner" ] && [ "$(lower <<<"$owner")" = "$(lower <<<"$EXPECT_OWNER")" ]
row "engine owner" $? "owner() = $owner (want $EXPECT_OWNER)"

# rows 3-4: the FURN token is finite, the engine is its treasury, and its supply is what the burns left
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
row "FURN token: finite, treasury = engine" $? "$sym $kind max_supply=$maxsup treasury=$treasury (want $EXPECT_INITIAL_SUPPLY, $EID)"
[ -n "$burned" ] && [ "$burned" -gt 0 ] && [ "$supply" = "$evm_supply" ] && [ "$supply" = "$((EXPECT_INITIAL_SUPPLY - burned))" ]
row "FURN supply = initial - burned" $? "mirror=$supply evm=$evm_supply initial=$EXPECT_INITIAL_SUPPLY totalBurned()=$burned"

# rows 5-6: every Burned log, split by whether the transaction that emitted it is flagged scheduled
logs=$(all_logs "$EID" | jq -r --arg t "$(cast keccak 'Burned(uint256,uint256,uint256,uint256,uint256)')" 'select(.topics[0]==$t)|"\(.timestamp) \(.data)"')
total=0 scheduled=0 manual=0 bad=0 sum=0 last_after=
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
done <<<"$logs"
[ "$total" -gt 0 ] && [ "$bad" = 0 ] && [ "$scheduled" -ge "$MIN_SCHEDULED_BURNS" ]
row "scheduled burns, scheduled=true" $? "$scheduled scheduled + $manual manual of $total Burned logs, $bad failed (want >= $MIN_SCHEDULED_BURNS scheduled)"
[ "$sum" = "$burned" ] && [ "$last_after" = "$supply" ]
row "Burned logs add up to the supply" $? "sum(tokensBurned)=$sum totalBurned()=$burned, last supplyAfter=$last_after supply=$supply"

# row 7: source verified on Sourcify (chain 296)
sm=$(curl -sf -A "verify-evidence.sh" "$SOURCIFY/$E" | jq -r '.match // "none"')
[ "$sm" = exact_match ] || [ "$sm" = match ]
row "Sourcify match, engine" $? "match = $sm (exact_match or match passes)"

echo
if [ "$fails" = 0 ]; then echo "ALL ROWS PASS"; else echo "$fails ROW(S) FAILED"; fi
[ "$fails" = 0 ]
