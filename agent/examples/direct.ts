/**
 * Calls the Furnace tools directly, no LLM in the loop, against the engine in deployedContracts.ts
 * (or FURNACE_ENGINE) on Hedera testnet.
 *
 *   npx tsx examples/direct.ts                        read-only: state, buyback preview, and the revenue transfer and buyback built as unsigned bytes
 *   npx tsx examples/direct.ts --revenue 1 [label]    send 1 HBAR of revenue, optionally tagged with a source label
 *   npx tsx examples/direct.ts --buyback [force]      buyback_now (owner, or anyone while a minimum gap is set)
 *   npx tsx examples/direct.ts --policy slippageBps=100   set_policy (owner)
 *   npx tsx examples/direct.ts --start 21600          start_automation (owner)
 *   npx tsx examples/direct.ts --stop                 stop_automation (owner)
 *   npx tsx examples/direct.ts --rearm                rearm_automation
 *
 * Write actions run only when their flag is given AND DEPLOYER_PRIVATE_KEY is set (read from the
 * environment or packages/foundry/.env). Nothing is printed from the key.
 */
import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createFurnacePlugin, furnaceToolNames as T } from "../src";
import { EngineChain } from "../src/chain";
import { configFromEnv } from "../src/config";

loadEnv({ path: fileURLToPath(new URL("../../packages/foundry/.env", import.meta.url)), quiet: true });
loadEnv({ quiet: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.indexOf(`--${name}`);
const value = (name: string, offset = 1) => (flag(name) >= 0 ? args[flag(name) + offset] : undefined);

const cfg = configFromEnv();
const chain = new EngineChain(cfg);
const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const client = Client.forTestnet();
let accountId = process.env.HEDERA_ACCOUNT_ID?.trim() || "";

if (key) {
  const priv = PrivateKey.fromStringECDSA(key);
  accountId = accountId || (await chain.account(`0x${priv.publicKey.toEvmAddress()}`)).accountId;
  client.setOperator(accountId, priv);
}

const plugin = createFurnacePlugin(cfg, chain);
const toolsFor = (context: Context) => Object.fromEntries(plugin.tools(context).map((t) => [t.method, t]));

async function run(label: string, tool: { execute: (c: Client, ctx: Context, p: unknown) => Promise<any> }, ctx: Context, params: unknown) {
  console.log(`\n== ${label}`);
  const out = await tool.execute(client, ctx, params);
  if (out.bytes) {
    // RETURN_BYTES mode: the kit returns the frozen, unsigned transaction itself.
    const { bytes, ...rest } = out;
    console.log(`Unsigned ${rest.type} ready: ${(bytes as Uint8Array).length} bytes, payer ${rest.payerAccountId}, valid until ${rest.expiresAt}. Not sent.`);
    console.log(JSON.stringify(rest, null, 2));
    return out;
  }
  console.log(out.humanMessage);
  console.log(JSON.stringify(out.raw, null, 2));
  return out;
}

const readCtx: Context = { mode: AgentMode.RETURN_BYTES, accountId: accountId || undefined };
const read = toolsFor(readCtx);
console.log(`engine ${cfg.engine}  rpc ${cfg.rpcUrl}  acting as ${accountId || "no account"}  write flags ${key ? "available (DEPLOYER_PRIVATE_KEY set)" : "off (no DEPLOYER_PRIVATE_KEY)"}`);

await run(T.state, read[T.state]!, readCtx, {});
await run(T.preview, read[T.preview]!, readCtx, {});

const writes = ["revenue", "buyback", "policy", "start", "stop", "rearm"].filter((f) => flag(f) >= 0);
if (writes.length === 0) {
  if (accountId) {
    // Return-bytes mode builds and freezes the transaction without signing or sending it.
    await run(`${T.revenue} (RETURN_BYTES, not sent)`, read[T.revenue]!, readCtx, { hbar: "1", source: "agent-demo" });
    await run(`${T.buyback} (RETURN_BYTES, not sent)`, read[T.buyback]!, readCtx, {});
  }
  console.log("\nRead-only run complete. Add --revenue 1, --buyback, --policy name=value, --start N, --stop or --rearm with DEPLOYER_PRIVATE_KEY set to send.");
} else if (!key) {
  console.error(`\nWrite flags (${writes.map((w) => `--${w}`).join(", ")}) need DEPLOYER_PRIVATE_KEY in the environment. Nothing was sent.`);
  process.exitCode = 1;
} else {
  const ctx: Context = { mode: AgentMode.AUTONOMOUS, accountId };
  const live = toolsFor(ctx);
  if (flag("revenue") >= 0) {
    const label = value("revenue", 2);
    await run(T.revenue, live[T.revenue]!, ctx, { hbar: value("revenue") ?? "1", ...(label && !label.startsWith("--") ? { source: label } : {}) });
  }
  if (flag("buyback") >= 0) await run(T.buyback, live[T.buyback]!, ctx, { force: value("buyback") === "force" });
  if (flag("policy") >= 0) {
    const [setting, v] = (value("policy") ?? "").split("=");
    await run(T.policy, live[T.policy]!, ctx, { setting, value: v });
  }
  if (flag("start") >= 0) await run(T.start, live[T.start]!, ctx, { intervalSeconds: Number(value("start") ?? 21_600) });
  if (flag("stop") >= 0) await run(T.stop, live[T.stop]!, ctx, {});
  if (flag("rearm") >= 0) await run(T.rearm, live[T.rearm]!, ctx, {});
}
client.close();
