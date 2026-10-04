#!/usr/bin/env bash
# Runs the two Foundry suites that grade a buyback cooldown and fails unless every test in both passes:
#   1. the agent's own FurnaceCooldown.t.sol, which must hold at least 3 passing tests;
#   2. the harness-owned FurnaceCooldownAcceptance.t.sol, copied in for the run and removed after it.
set -euo pipefail
cd "$(dirname "$0")/../.."

ACCEPT_SRC=.harness/validators/FurnaceCooldownAcceptance.t.sol
ACCEPT_DEST=packages/foundry/test/HarnessCooldownAcceptance.t.sol
OWN_MIN=3
ACCEPT_TESTS=9

# Counts tests in forge's --json output: prints "<passed> <failed>".
count() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    let ok = 0, bad = 0;
    for (const suite of Object.values(r))
      for (const t of Object.values(suite.test_results)) t.status === "Success" ? ok++ : bad++;
    console.log(ok + " " + bad);'
}

run_suite() {
  local path=$1 json
  json=$(yarn foundry:test --match-path "$path" --json 2>/dev/null) || {
    echo "forge could not run $path (compile error or failing test). Re-run: yarn foundry:test --match-path $path" >&2
    return 1
  }
  count <<<"$json"
}

[ ! -e "$ACCEPT_DEST" ] || { echo "$ACCEPT_DEST already exists; the agent must not create it" >&2; exit 1; }
cp "$ACCEPT_SRC" "$ACCEPT_DEST"
trap 'rm -f "$ACCEPT_DEST"' EXIT

read -r own_ok own_bad < <(run_suite test/FurnaceCooldown.t.sol)
echo "agent suite: $own_ok passed, $own_bad failed (needs >= $OWN_MIN passed, 0 failed)"
[ "$own_bad" -eq 0 ] && [ "$own_ok" -ge "$OWN_MIN" ]

read -r acc_ok acc_bad < <(run_suite test/HarnessCooldownAcceptance.t.sol)
echo "acceptance suite: $acc_ok passed, $acc_bad failed (needs exactly $ACCEPT_TESTS passed, 0 failed)"
[ "$acc_bad" -eq 0 ] && [ "$acc_ok" -eq "$ACCEPT_TESTS" ]
