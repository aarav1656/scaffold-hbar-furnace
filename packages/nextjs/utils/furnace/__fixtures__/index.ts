import type { MirrorLog, TokenInfo } from "../mirror";
import logsJson from "./engine-logs.json";
import tokenJson from "./token-info.json";

/**
 * Captured from the live Hedera testnet mirror node (GET /contracts/0x706947eC.../results/logs?limit=100&order=desc),
 * the engine's complete history: 29 logs, newest first, trimmed to the fields the decoder reads.
 */
export const LIVE_LOGS = logsJson.logs as MirrorLog[];

/** GET /tokens/0.0.10840036 on the same node, read at the same time as the logs. */
export const LIVE_TOKEN = tokenJson as unknown as TokenInfo;

export const ENGINE = "0x706947eCC0411bAdeF790282bb89b80126357D9D" as const;

export const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
