import { jsonResponse } from ".";
import type { MirrorLog } from "../mirror";
import { vi } from "vitest";

/** Serves `logs` as one mirror node page for any request, and returns the fetch mock. */
export function stubMirrorLogs(logs: MirrorLog[]) {
  const mock = vi.fn(async () => jsonResponse({ logs, links: { next: null } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
