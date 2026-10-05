# Furnace

**Live app:** [furnace-hbar.vercel.app](https://furnace-hbar.vercel.app) · **Demo video:** [docs/demo/furnace-demo.mp4](docs/demo/furnace-demo.mp4) (2 min 26 s)

A buyback-and-burn engine for a Hedera token, as a [Scaffold-HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar/index) template. Send protocol revenue in as HBAR. The engine buys the team's HTS token on SaucerSwap V1 and burns it with the supply key it holds, so `total_supply` falls on the mirror node. Hedera runs that buy on a schedule the engine booked for itself.

Each buy stays inside a USD daily budget, a lot size and a minimum gap. The engine skips a buy that would pay above a USD price ceiling, move the pool past a set price impact, or trade while the pool sits above its own average price. The skip is named on chain. The schedule keeps going.

![Furnace dashboard on Hedera testnet: supply falling burn by burn](docs/images/dashboard.png)

**3 burns on engine v2 were executed by the Hedera network.** Supply moved from 1,000,000 to 959,430.9642213 FURN (4.06% burned). The mirror read also shows `TooSoon` inside the minimum gap, and `TwapDeviation` after a swap pushed the pool above its average. Counted at 2026-10-04 20:28 UTC.

```bash
npm create scaffold-hbar@latest -- --template aarav1656/scaffold-hbar-furnace
```

The `--` matters with `npm create`. Without it, npm keeps `--template` for itself.

## What does the work

| Protocol | Job in Furnace |
| --- | --- |
| Hedera Token Service | Creates the token with the engine as treasury and sole supply key, then `burnToken` on exactly the tokens the swap just bought |
| Hedera Schedule Service (HIP-1215) | `startAutomation` books the first run. Each run books the next one before it buys. The engine pays for its own runs |
| SaucerSwap V1 | Pool creation, the liquidity seed, and every buyback. Pair reserves set the price-impact cap |
| Chainlink HBAR/USD | The budget and the price ceiling are in USD. A stale or non-positive answer stops the buy |
| Exchange rate precompile (0x168) | Converts SaucerSwap's tinycents pair-creation fee into tinybar at call time |

## Proof

Engine v2 is `0x3249617e95785640140A05f55Fd9c798F0E116Df` ([HashScan](https://hashscan.io/testnet/contract/0x3249617e95785640140A05f55Fd9c798F0E116Df), Sourcify exact match). Token [0.0.10860654](https://hashscan.io/testnet/token/0.0.10860654).

- A burn nobody sent: [scheduled run](https://hashscan.io/testnet/transaction/1791141365.032140514), `CONTRACTCALL`, `scheduled: true`, paid by the engine, emitting `Burned`.
- Supply on the mirror is 95,943,096,422,130 raw units (8 decimals) after 3 scheduled burns and one manual burn.
- A pool moved, and the next buy was refused: [swap](https://hashscan.io/testnet/transaction/0x254c92f73c72060b953995a311428b7d4db4afa380367bc4886bdd84b5cc5dd8), then [buyback](https://hashscan.io/testnet/transaction/0xaaeb7948bac3f9239d153fc77e40ab5a6a5f46a723844667c70bf1affd8beb82) with `BuybackSkipped(TwapDeviation)`.

Every row has a re-check command in [docs/testnet-evidence.md](docs/testnet-evidence.md). Engine v1, the earlier deployment, is still burning on its own schedule (5 scheduled burns, 10.57% of that supply). Its rows are in [docs/details.md](docs/details.md#proven-on-hedera-testnet).

## Five-minute path

Prerequisites: Node.js 20.18.3 or newer, Yarn (`corepack enable`) or npm, Foundry 1.7.1 (`foundryup --install v1.7.1`; Hashio rejects Foundry 1.8, [hiero-json-rpc-relay#5826](https://github.com/hiero-ledger/hiero-json-rpc-relay/issues/5826)), plus `jq`, `curl` and `bc`.

```bash
npm create scaffold-hbar@latest -- --template aarav1656/scaffold-hbar-furnace my-furnace
cd my-furnace
yarn foundry:test
```

1. Fund an ECDSA testnet account at the [Hedera faucet](https://portal.hedera.com/faucet) and put its key in `packages/foundry/.env` as `DEPLOYER_PRIVATE_KEY`.
2. `yarn foundry:live` deploys an engine, creates the token and the pool, burns once by hand and once on a network-triggered schedule, and prints a HashScan link per transaction.
3. `yarn next:dev` serves the dashboard on port 3000.
4. Point revenue at the engine from the Send revenue panel, or transfer HBAR to the engine address.

In an npm project every `yarn x` is `npm run x`. Policy knobs (`DAILY_BUDGET_USD`, `MAX_IMPACT_BPS`, `PRICE_CEILING_USD`, and the rest) are in [docs/details.md](docs/details.md#customize).

## Documentation

- [docs/details.md](docs/details.md): why a burn changes supply, how a buy is sized, the full testnet ledger, costs, mainnet addresses, the test suite, the Harness recipe and the agent plugin.
- [docs/architecture.md](docs/architecture.md): who can call what, and the calls each run makes.
- [docs/hedera-gotchas.md](docs/hedera-gotchas.md): the Hedera behaviours the engine is built around, each with a command that reproduces it.
- [docs/testnet-evidence.md](docs/testnet-evidence.md): every claim with the command that re-checks it.
- [agent/README.md](agent/README.md): the Hedera Agent Kit plugin.
- [AGENTS.md](AGENTS.md): briefing for coding agents.

## License

MIT. See [LICENCE](LICENCE).
