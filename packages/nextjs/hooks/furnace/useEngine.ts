import { useQuery } from "@tanstack/react-query";
import { type Address, zeroAddress } from "viem";
import { useAccount, useBalance, useGasPrice, usePublicClient } from "wagmi";
import {
  CHAIN_ID,
  ENGINE_ABI,
  ENGINE_ADDRESS,
  FEED_ABI,
  IS_DEPLOYED,
  POLL_MS,
  SKIP_REASONS,
  type SkipReason,
} from "~~/utils/furnace/constants";
import { fetchEngineEvents, fetchRunFee, fetchTokenInfo } from "~~/utils/furnace/mirror";

export const isSet = (address: Address) => address.toLowerCase() !== zeroAddress;

/** Values the contract fixes at deploy: ownership, limits and the fuel policy. */
function useEngineConfig() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["furnace", "config", ENGINE_ADDRESS],
    enabled: !!client && IS_DEPLOYED,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const read = client!.readContract;
      const base = { address: ENGINE_ADDRESS, abi: ENGINE_ABI } as const;
      const [owner, feed, fuelReserve, minSpend, scheduledGas, maxOracleAge] = await Promise.all([
        read({ ...base, functionName: "owner" }),
        read({ ...base, functionName: "hbarUsdFeed" }),
        read({ ...base, functionName: "fuelReserve" }),
        read({ ...base, functionName: "minSpend" }),
        read({ ...base, functionName: "scheduledGas" }),
        read({ ...base, functionName: "maxOracleAge" }),
      ]);
      const [minInterval, maxInterval, maxImpactBps, maxSlippageBps] = await Promise.all([
        read({ ...base, functionName: "MIN_INTERVAL" }),
        read({ ...base, functionName: "MAX_INTERVAL" }),
        read({ ...base, functionName: "MAX_IMPACT_BPS" }),
        read({ ...base, functionName: "MAX_SLIPPAGE_BPS" }),
      ]);
      return {
        owner,
        feed,
        fuelReserve,
        minSpend,
        scheduledGas,
        maxOracleAge: Number(maxOracleAge),
        minInterval: Number(minInterval),
        maxInterval: Number(maxInterval),
        maxImpactBps: Number(maxImpactBps),
        maxSlippageBps: Number(maxSlippageBps),
      };
    },
  });
}

export type EngineConfig = NonNullable<ReturnType<typeof useEngineConfig>["data"]>;

/** Everything that moves: the engine's own `status()`, the policy, the dry run of a buyback and the oracle. */
function useEngineLive(config: EngineConfig | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["furnace", "live", ENGINE_ADDRESS],
    enabled: !!client && !!config,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const read = client!.readContract;
      const base = { address: ENGINE_ADDRESS, abi: ENGINE_ABI } as const;
      const [status, tokenDecimals, dailyBudgetUsd, maxImpactBps, priceCeilingUsd, slippageBps, windowStart] =
        await Promise.all([
          read({ ...base, functionName: "status" }),
          read({ ...base, functionName: "tokenDecimals" }),
          read({ ...base, functionName: "dailyBudgetUsd" }),
          read({ ...base, functionName: "maxImpactBps" }),
          read({ ...base, functionName: "priceCeilingUsd" }),
          read({ ...base, functionName: "slippageBps" }),
          read({ ...base, functionName: "windowStart" }),
        ]);
      const [preview, round, poolFee] = await Promise.allSettled([
        read({ ...base, functionName: "previewBuyback" }),
        read({ address: config!.feed, abi: FEED_ABI, functionName: "latestRoundData" }),
        read({ ...base, functionName: "poolCreationFee" }),
      ]);
      const val = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : undefined);
      const previewValue = val(preview);
      const feedRound = val(round);
      return {
        s: status,
        tokenDecimals,
        dailyBudgetUsd,
        maxImpactBps: Number(maxImpactBps),
        priceCeilingUsd,
        slippageBps: Number(slippageBps),
        windowStart: Number(windowStart),
        /** Undefined when the dry run itself reverts, which is what a stale oracle does. */
        preview: previewValue
          ? { skip: SKIP_REASONS[previewValue[0]] as SkipReason, spend: previewValue[1] }
          : undefined,
        feed: feedRound ? { answer: feedRound[1], updatedAt: Number(feedRound[3]) } : undefined,
        poolFee: val(poolFee),
      };
    },
  });
}

export type EngineLive = NonNullable<ReturnType<typeof useEngineLive>["data"]>;

/** Supply, max supply and key facts of the HTS token, from the mirror node. */
function useTokenInfo(token: Address | undefined) {
  return useQuery({
    queryKey: ["furnace", "token", token],
    enabled: !!token && isSet(token),
    refetchInterval: POLL_MS,
    queryFn: () => fetchTokenInfo(token!),
  });
}

/** The engine's decoded events from the mirror node, refreshed on a timer. */
export function useEngineEvents() {
  return useQuery({
    queryKey: ["furnace", "events", ENGINE_ADDRESS],
    enabled: IS_DEPLOYED,
    refetchInterval: POLL_MS,
    queryFn: () => fetchEngineEvents(ENGINE_ADDRESS),
  });
}

/** What the latest scheduled run cost the engine, from the transaction the mirror node recorded for it. */
function useLastRunFee(timestamp: string | undefined) {
  return useQuery({
    queryKey: ["furnace", "runFee", timestamp],
    enabled: !!timestamp,
    staleTime: Infinity,
    queryFn: () => fetchRunFee(timestamp!),
  });
}

/** One read model of the engine for the whole page. */
export function useEngine() {
  const { address } = useAccount();
  const config = useEngineConfig();
  const live = useEngineLive(config.data);
  const tokenAddress = live.data && isSet(live.data.s.token) ? live.data.s.token : undefined;
  const tokenInfo = useTokenInfo(tokenAddress);
  const events = useEngineEvents();
  const lastRun = events.data?.events.find(e => e.name === "ScheduledRun");
  const lastRunFee = useLastRunFee(lastRun?.timestamp);
  const wallet = useBalance({ address, chainId: CHAIN_ID, query: { enabled: !!address, refetchInterval: POLL_MS } });
  const gasPrice = useGasPrice({ chainId: CHAIN_ID, query: { refetchInterval: POLL_MS } });
  return { deployed: IS_DEPLOYED, config, live, tokenInfo, events, lastRunFee, wallet, gasPrice };
}

export type Engine = ReturnType<typeof useEngine>;
/** An engine read model whose config and live state have both arrived. */
export type Snapshot = { engine: Engine; cfg: EngineConfig; lv: EngineLive };
