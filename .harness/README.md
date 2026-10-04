# Hedera Harness recipe: a buyback cooldown

This directory is a [hedera-harness](https://github.com/hedera-dev/hedera-harness)
recipe. It asks a coding agent for the extension a token team makes first to
this template: a minimum number of seconds between two buybacks, set by the
owner, enforced inside `_plan()` so the scheduled run, the owner's `buyback()`
and the `previewBuyback()` dry run all agree, and shown in the Policy panel.
The harness, not the agent, decides whether the run passed.

| File | Tier | What it checks |
| --- | --- | --- |
| `prd.md` | n/a | What to build, with the exact names: `setBuybackCooldown`, `buybackCooldown`, `lastBuybackAt`, `MAX_BUYBACK_COOLDOWN`, `Skip.Cooldown`. |
| `validators/static.json` | 0 | The names exist in the engine, the reviewed-surface test, the agent's `FurnaceCooldown.t.sol`, the page constants, the hook, the Policy panel and `AGENTS.md`. No `.env`. |
| `validators/yarn.json` | 1 | `yarn install`, the whole Foundry suite, lint (`next lint` and `forge fmt --check`), strict types and the production build. |
| `validators/acceptance.sh` | 1 | The agent's own suite passes with at least 3 tests, then a harness-owned suite (`FurnaceCooldownAcceptance.t.sol`, 9 tests) is copied in, run and removed. It pins the rule: off by default, owner-only and bounded setter, skip inside the cooldown with nothing spent or burned, reopens on the exact second measured from the last spend, a skip for another reason never starts the cooldown, no oracle read inside the cooldown, and a scheduled run inside the cooldown neither reverts nor stops booking. |
| `validators/invariants.mjs` | 1 | Source checks on the engine rules the change must not disturb: `runScheduled` books first, never reverts and books once; `buyback` burns only the balance difference around the swap and keeps `AllocationBreach`; one `_plan()` sizes the buyback; the cooldown is stamped only on the path that spends; no withdraw, sweep or rescue; the page's `SKIP_REASONS` matches the Solidity `Skip` enum in order; `deployedContracts.ts` stays generated. |

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
setter and tests, `SKIP_REASONS`, `COOLDOWN_ABI`, the hook and the Policy panel
row, `AGENTS.md`). No coding agent ran.

| Copy | Result | Detail |
| --- | --- | --- |
| Template as committed | `passed=false`, `findings=17` | 15 missing names or files, plus `cooldown-acceptance` and `engine-rules`. `yarn install`, `foundry:test` (149 tests), `lint`, `next:check-types` and `next:build` all exit 0, so none of the 17 is a false alarm. |
| Template with the reference | `passed=true`, `findings=0` | 160 tests in `foundry:test`, agent suite 3 passed, acceptance suite 9 passed, engine rules hold, lint, types and build exit 0. The acceptance file is removed after the run. |

Each validator also fails when the rule it guards is broken. Four deliberate
bugs in the reference engine, each restored afterwards (acceptance and
engine-rules both red for every one, then both green again):

| Bug | Caught by |
| --- | --- |
| The cooldown comparison replaced by `false` | agent suite and `_plan` rule |
| `runScheduled` buys before it books its successor | acceptance suite and book-first rule |
| `lastBuybackAt` stamped before the skip return | agent suite and stamp rule |
| `buyback` burns the engine's whole balance, not the swap's difference | burn-only-bought rule |
