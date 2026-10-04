# Furnace agent plugin

A [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js) plugin that lets an AI agent operate the Furnace buyback-and-burn engine. The engine already runs itself: the Hedera network executes its buybacks from a schedule the engine booked. This plugin gives an agent the other half, a typed set of tools to read the engine, feed it revenue, preview and run a buyback, change the policy and keep the schedule alive.

It is a standalone folder with its own `package.json`. It is not a workspace of the scaffold, so `yarn install` at the repo root never touches it.

## Tools

| Tool | Kind | What the agent gets |
| --- | --- | --- |
| `get_furnace_state` | query | Token supply, total burned and burn count split between the network's own scheduled runs and direct calls (counted from the mirror node and reconciled to the contract's `totalBurned`), budget left in USD and HBAR, the full buyback policy, the next scheduled burn, how many scheduled runs the fuel covers, and whether a buyback would spend now. |
| `preview_buyback` | query | What a buyback would spend and burn right now (HBAR, USD, the router's token quote), or the exact `Skip` reason with its meaning, and who may trigger it. |
| `send_revenue` | transaction | HBAR to the engine. With a `source` label it calls `depositRevenue(source)` and the origin is recorded on chain; without one it is a plain transfer to `receive()`. Proves the engine's `RevenueTagged` or `RevenueReceived` event carries the same amount from the same account. |
| `buyback_now` | transaction | `buyback()`. Owner, or anyone while the owner has set a minimum gap and the buy would spend. Sends nothing when the engine would skip unless `force` is set. Proves the `Burned` event against the contract's `totalBurned`. |
| `set_policy` | transaction | Owner only. One of the seven setters: `dailyBudgetUsd`, `priceCeilingUsd`, `maxLotUsd`, `maxImpactBps`, `slippageBps`, `minGapSeconds`, `maxTwapDeviationBps`. Values are checked against the contract's own bounds first, an unchanged value is a no-op, and the new value is read back from the contract. |
| `start_automation` | transaction | Owner only. `startAutomation(interval)`. Proves the interval is set and a pending schedule with a future run time exists. |
| `stop_automation` | transaction | Owner only. `stopAutomation()`. Proves the interval and the pending schedule read as cleared. |
| `rearm_automation` | transaction | `rearm()` when automation is on and the booked run is missing or more than ten minutes overdue. Anyone may call it. Proves a new schedule replaced the stale one. |

The engine address is read from `packages/nextjs/contracts/deployedContracts.ts` (chain 296) every time the plugin starts, so a redeploy is picked up without a code change. A tool is offered only when that file's ABI contains the functions it calls. `FURNACE_ENGINE=0x...` points the plugin at an engine without the scaffold checked out; `HEDERA_RPC_URL` and `HEDERA_MIRROR_URL` override the endpoints.

Every input is a zod schema (decimal strings with at most 8 places, bounded integers, printable-ASCII source labels), parsed again inside the tool so a direct call is checked like an LLM call. Every result is `{ raw, humanMessage }` with decimal strings instead of bigints and HashScan links for the transaction, engine, token and schedule.

A refused write returns `raw.status: "ERROR"` with `raw.blocked: true` and the reasons, and sends nothing. A reverted write returns the engine's own error name decoded from the mirror node (`NotOwnerOrSelf`, `BuybackRefused`, `ScheduleLive`).

### Transaction modes

Write tools follow the Agent Kit's `AgentMode`. In `AUTONOMOUS` the operator key signs and the tool waits for the mirror node and checks the post-condition. In `RETURN_BYTES` the tool returns the frozen, unsigned transaction for a wallet or a human to sign, along with the plan it built.

## Run it

```bash
cd agent
npm install
npm test                 # unit tests, no network
npm run typecheck
```

### Without an LLM

```bash
npx tsx examples/direct.ts                          # read-only: state, buyback preview, revenue and buyback built as unsigned bytes
npx tsx examples/direct.ts --revenue 1 swap-fees    # send 1 HBAR tagged "swap-fees" through send_revenue
npx tsx examples/direct.ts --buyback                # buyback_now (owner)
npx tsx examples/direct.ts --policy slippageBps=100 # set_policy (owner)
npx tsx examples/direct.ts --start 21600            # start_automation (owner)
npx tsx examples/direct.ts --stop                   # stop_automation (owner)
npx tsx examples/direct.ts --rearm                  # rearm_automation
```

Write flags run only when `DEPLOYER_PRIVATE_KEY` is set in the environment or in `packages/foundry/.env`; the key is never printed. The recorded read-only output is in [examples/direct-readonly.txt](examples/direct-readonly.txt) and the revenue write in [examples/direct-write-revenue.txt](examples/direct-write-revenue.txt).

### With an LLM

```bash
OPENAI_API_KEY=... npx tsx examples/ask.ts "How much has been burned, and who triggered the burns?"
ANTHROPIC_API_KEY=... MODEL=anthropic:claude-sonnet-4-5 npx tsx examples/ask.ts "What would a buyback spend right now?"
npx tsx examples/ask.ts --bytes "Send 1 HBAR of revenue tagged swap-fees"   # the agent builds the transaction, you sign it
```

[examples/ask.ts](examples/ask.ts) loads the plugin into `HederaAIToolkit` from `@hashgraph/hedera-agent-kit-ai-sdk`. Any AI SDK language model works; OpenAI and Anthropic are wired through `MODEL`.

## Load it into an Agent Kit app

```ts
import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { HederaAIToolkit } from "@hashgraph/hedera-agent-kit-ai-sdk";
import { createFurnacePlugin } from "./agent/src";

const toolkit = new HederaAIToolkit({
  client,
  configuration: { plugins: [createFurnacePlugin()], context: { mode: AgentMode.AUTONOMOUS, accountId } },
});
```

`createFurnacePlugin(config?, chain?)` returns a standard Agent Kit `Plugin` (`name`, `version`, `description`, `tools(context)`), so it sits next to the kit's own plugins in the same `plugins` array and works with the LangChain toolkit the same way. Copy the `agent/` folder into the app, run `npm install` inside it, and set `FURNACE_ENGINE` to the engine address when the scaffold is not alongside it.

### Agent Lab

[Agent Lab](https://portal.hedera.com/agent-lab) builds agents on the Agent Kit and lists community plugins. To give an agent downloaded from Agent Lab the Furnace tools:

1. Copy `agent/` into the downloaded project and run `npm install` inside it.
2. Add `createFurnacePlugin()` to the `plugins` array of the toolkit the project already constructs, next to the plugins Agent Lab generated.
3. Set `FURNACE_ENGINE` in the project's `.env`.
4. Restart the agent. The eight tools appear in its tool list and the model calls them by name (`get_furnace_state`, `send_revenue`, and so on).

## Proof on Hedera testnet

`examples/direct.ts` against the v2 engine `0x3249617e95785640140a05f55fd9c798f0e116df`, signed by the deployer account 0.0.10855086 through the tool:

| Tool call | Result | HashScan |
| --- | --- | --- |
| `send_revenue` 1 HBAR tagged `agent-plugin` | `depositRevenue` succeeded and the engine emitted `RevenueTagged(source="agent-plugin", amount=100000000)`, equal to the tool's own check | [transaction](https://hashscan.io/testnet/transaction/0.0.10855086-1791141309-672068643) |
| `get_furnace_state` after the network's scheduled run | 1 burn by the network, 1 by a direct call, the mirror node total equal to the contract's `totalBurned` (21985.57339611 FURN) | [engine](https://hashscan.io/testnet/contract/0x3249617e95785640140a05f55fd9c798f0e116df) |

Re-check the revenue: `curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0.0.10855086-1791141309-672068643 | jq '{result,gas_used,amount,topic:.logs[0].topics[1]}'` returns `SUCCESS`, 23483 gas, 100000000 tinybar and the label `agent-plugin` as bytes32.

## Layout

| Path | Role |
| --- | --- |
| `src/tools.ts` | The eight tools, built on the kit's `BaseQueryTool` and `BaseTransactionTool` |
| `src/plugin.ts` | `createFurnacePlugin`, the kit `Plugin` |
| `src/chain.ts` | Contract views over viem, the paged mirror node burn ledger, revert decoding. A `ChainReader` interface lets tests run the tools without a network |
| `src/config.ts` | Reads the engine address and ABI function names from `deployedContracts.ts` |
| `src/analysis.ts`, `src/units.ts`, `src/shape.ts` | Pure functions: skip reasons, network versus manual burns, fuel runway, policy bounds, result shaping |
| `src/schemas.ts` | zod input schemas |
| `test/` | vitest: input validation, result shaping, every tool's blocked, no-op, build and proof paths, toolkit loading |
