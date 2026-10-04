import type { Context, Plugin, Tool } from "@hashgraph/hedera-agent-kit";
import { type ChainReader, EngineChain } from "./chain";
import { type EngineConfig, configFromEnv, hasFunction } from "./config";
import { BuybackNow, GetFurnaceState, PreviewBuyback, RearmAutomation, SendRevenue, SetPolicy, StartAutomation, StopAutomation, TOOL_NAMES, TOOL_REQUIRES } from "./tools";

/**
 * The Furnace plugin for the Hedera Agent Kit. `chain` is injectable so tests can run the tools without a
 * network; by default every tool reads the engine in `config` over JSON-RPC and the mirror node. A tool is
 * offered only when the engine's deployed ABI has the functions it calls.
 */
export function createFurnacePlugin(config: EngineConfig = configFromEnv(), chain: ChainReader = new EngineChain(config)): Plugin {
  const all: Tool[] = [
    new GetFurnaceState(chain),
    new PreviewBuyback(chain),
    new SendRevenue(chain),
    new BuybackNow(chain),
    new SetPolicy(chain),
    new StartAutomation(chain),
    new StopAutomation(chain),
    new RearmAutomation(chain),
  ];
  return {
    name: "furnace",
    version: "1.0.0",
    description:
      "Operate the Furnace buyback-and-burn engine on Hedera: read supply, burns and budget, preview a buyback, send revenue, and as owner run a buyback, change the policy and control the schedule.",
    tools: (_context: Context): Tool[] => all.filter((t) => TOOL_REQUIRES[t.method]!.every((fn) => hasFunction(config, fn))),
  };
}

export const furnaceToolNames = TOOL_NAMES;
