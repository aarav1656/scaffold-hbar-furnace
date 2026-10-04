import { ExternalLink, Panel, Row } from "./ui";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { ENGINE_ADDRESS } from "~~/utils/furnace/constants";
import { shortAddress } from "~~/utils/furnace/format";
import { hashscan } from "~~/utils/furnace/hedera";

/** Contract number inside a protobuf-encoded key (ContractID: field 1, its num is field 3), or undefined. */
function contractNumOfKey(key: unknown): string | undefined {
  const hex = (key as { _type?: string; key?: string } | null)?.key;
  if (!hex || !/^0a[0-9a-f]{2}/.test(hex)) return undefined;
  const bytes = hex.match(/../g)!.map(b => parseInt(b, 16));
  let i = 2;
  while (i < bytes.length && bytes[i] !== 0x18) i += 2; // skip shard (0x08) and realm (0x10) varints
  if (bytes[i] !== 0x18) return undefined;
  let num = 0n;
  for (let shift = 0n, j = i + 1; j < bytes.length; j++, shift += 7n) {
    num |= BigInt(bytes[j] & 0x7f) << shift;
    if (!(bytes[j] & 0x80)) break;
  }
  return num.toString();
}

/** What the network itself enforces about the token and the pool, read off the mirror node. */
export function LockedPanel({ snap }: { snap: Snapshot }) {
  const { engine, lv } = snap;
  const info = engine.tokenInfo.data;
  const keys = info
    ? ([
        ["admin", info.admin_key],
        ["wipe", info.wipe_key],
        ["freeze", info.freeze_key],
        ["pause", info.pause_key],
        ["KYC", info.kyc_key],
        ["fee schedule", info.fee_schedule_key],
      ] as const)
    : [];
  const engineHolds = !!info && contractNumOfKey(info.supply_key) === info.treasury_account_id.split(".")[2];
  const held = keys.filter(([, key]) => key !== null).map(([name]) => name);

  return (
    <Panel id="locked-title" title="Locked in" note="Read from the mirror node">
      {info ? (
        <dl className="m-0 mt-3">
          <Row label="Supply" note="The network refuses a mint past the maximum.">
            {info.supply_type === "FINITE" ? "Finite" : "Uncapped"}
          </Row>
          <Row
            label="Admin, wipe, freeze, pause, KYC keys"
            note={held.length ? undefined : "Nobody can freeze a holder, wipe a balance or change the token."}
          >
            <span className={held.length ? "text-error" : ""}>{held.length ? `Set: ${held.join(", ")}` : "None"}</span>
          </Row>
          <Row label="Treasury" note="Where the supply sits until it is bought or claimed.">
            <ExternalLink href={hashscan.account(info.treasury_account_id)}>{info.treasury_account_id}</ExternalLink>
          </Row>
          <Row label="Supply key" note={engineHolds ? "Only the engine's own buyback can burn." : undefined}>
            {info.supply_key === null ? "None" : engineHolds ? "The engine" : "Another key"}
          </Row>
          <Row label="Liquidity" note="The engine holds every LP token and has no function that moves them.">
            {lv.s.lpToken && lv.s.lpToken !== "0x0000000000000000000000000000000000000000" ? (
              <ExternalLink href={hashscan.token(lv.s.lpToken)}>LP token</ExternalLink>
            ) : (
              "No pool yet"
            )}
          </Row>
          <Row label="Engine" note="No withdraw, sweep or rescue function exists on it.">
            <ExternalLink href={hashscan.contract(ENGINE_ADDRESS)}>{shortAddress(ENGINE_ADDRESS)}</ExternalLink>
          </Row>
        </dl>
      ) : (
        <p className="m-0 mt-4 text-sm text-base-content/70">Reading the token from the mirror node.</p>
      )}
    </Panel>
  );
}
