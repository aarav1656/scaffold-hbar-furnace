# Hedera Harness recipe: a buyback pause

This directory is a [hedera-harness](https://github.com/hedera-dev/hedera-harness)
recipe. It asks a coding agent for the extension a token team makes next to
the v2 engine: an owner-set pause that stops buying during an incident or ahead
of an announcement while the engine keeps booking its schedule. The pause is
decided inside `_plan()` so the scheduled run, the owner's `buyback()` and the
`previewBuyback()` dry run all agree, and it is shown in the Policy panel. The
harness, not the agent, decides whether the run passed.

The engine already carries a lot cap, a minimum gap between buys and an
average-price bound. The pause is a different control: it is checked before the
oracle is read and needs no clock, so it works when the oracle is the problem.

| File | Tier | What it checks |
| --- | --- | --- |
| `prd.md` | n/a | What to build, with the exact names: `setBuybacksPaused`, `buybacksPaused`, `BuybacksPausedSet`, `Skip.Paused`. |
| `validators/static.json` | 0 | The names exist in the engine, the reviewed-surface test, the agent's `FurnacePause.t.sol`, the page constants, the hook, the Policy panel and `AGENTS.md`. No `.env`. |
| `validators/yarn.json` | 1 | `yarn install`, the whole Foundry suite, lint (`next lint` and `forge fmt --check`), strict types and the production build. |
| `validators/acceptance.sh` | 1 | The agent's own suite passes with at least 3 tests, then a harness-owned suite (`FurnacePauseAcceptance.t.sol`, 9 tests) is copied in, run and removed. It pins the rule: off by default, owner-only setter that emits both ways, a paused run skips with nothing spent or burned and never reaches the router, unpausing resumes, no oracle read while paused, the spend ledger untouched, revenue and policy still work while paused, burns stay only what was bought across pause cycles, and a scheduled run while paused neither reverts nor stops booking. |
| `validators/invariants.mjs` | 1 | Source checks on the engine rules the change must not disturb: `runScheduled` books first, never reverts and books once; `buyback` burns only the balance difference around the swap and keeps `AllocationBreach`; one `_plan()` sizes the buyback and keeps the minimum gap, the lot cap and the average-price bound; `buyback` keeps moving the price snapshot; the pause is decided in `_plan()` before the oracle and never re-checked in `buyback` or `runScheduled`; the spend stamp `lastBuyAt` is written only after the skip return; no withdraw, sweep or rescue; the page's `SKIP_REASONS` matches the Solidity `Skip` enum in order; `deployedContracts.ts` stays generated. |

## Running it

```bash
npx hedera-harness doctor     # prerequisites, the recipe, every path it references
npx hedera-harness validate   # Tiers 0 and 1, no agent
npx hedera-harness run        # the full run: agent, repairs, validators
```

No testnet funds or secrets are needed. `forbiddenFiles` in `spec.yaml` leaves
out `packages/foundry/.env`, which the foundry postinstall creates from
`.env.example` on every `yarn install`.

## Proof in both directions

`hedera-harness validate` ran in two clean copies of the template, one as
committed and one with a minimal reference implementation applied (engine,
setter and tests, `SKIP_REASONS`, `PAUSE_ABI`, the hook and the Policy panel
row, `AGENTS.md`). No coding agent ran.

| Copy | Result | Detail |
| --- | --- | --- |
| Template as committed | `passed=false`, `findings=15` | 13 missing names or files, plus `pause-acceptance` and `engine-rules`. `yarn install`, `foundry:test` (269 tests), `lint`, `next:check-types` and `next:build` all exit 0, so none of the 15 is a false alarm. |
| Template with the reference | `passed=true`, `findings=0` | 272 tests in `foundry:test`, agent suite 3 passed, acceptance suite 9 passed, engine rules hold, lint, types and build exit 0. The acceptance file is removed after the run. |

Each validator also fails when the rule it guards is broken. Five deliberate
bugs in the reference engine, each restored afterwards (the restored copy runs
acceptance and engine-rules green again):

| Bug | Caught by |
| --- | --- |
| The pause comparison replaced by `false` | agent suite and `_plan` rule |
| `runScheduled` buys before it books its successor | acceptance suite and book-first rule |
| `lastBuyAt` stamped before the skip return | acceptance suite and stamp rule (the stamp rule also fires alone) |
| `buyback` burns the engine's whole balance, not the swap's difference | agent suite and burn-only-bought rule |
| The pause checked inside `buyback()` instead of `_plan()` | one-sizing-function rule (the acceptance suite stays green, so this rule is the only guard) |
