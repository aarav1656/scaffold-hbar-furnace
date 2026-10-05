"use client";

import { ActivityFeed } from "./ActivityFeed";
import { EnginePanel, runsOfFuel } from "./EnginePanel";
import { LockedPanel } from "./LockedPanel";
import { OwnerControls } from "./OwnerControls";
import { PolicyPanel } from "./PolicyPanel";
import { RevenuePanel } from "./RevenuePanel";
import { SupplyPanel } from "./SupplyPanel";
import { Notice } from "./ui";
import { isSet, useEngine } from "~~/hooks/furnace/useEngine";
import type { Snapshot } from "~~/hooks/furnace/useEngine";
import { useWalletReady } from "~~/hooks/furnace/useTx";
import { ENGINE_ADDRESS } from "~~/utils/furnace/constants";
import { hashscan } from "~~/utils/furnace/hedera";

export function FurnaceView() {
  const engine = useEngine();
  const { config, live } = engine;
  const symbol = engine.tokenInfo.data?.symbol;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <header>
        <h1 className="m-0 text-5xl leading-[1.05] md:text-6xl">
          Revenue buys {symbol ?? "the token"} back and <span className="text-primary">burns it.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base text-slate">
          Send HBAR to the engine. On its own Hedera schedule it buys {symbol ?? "the token"} on SaucerSwap inside a USD
          daily budget, below a price ceiling, then burns every token it bought. The network enforces the supply.{" "}
          {engine.deployed && (
            <a className="link link-primary" href={hashscan.contract(ENGINE_ADDRESS)} target="_blank" rel="noreferrer">
              Engine on HashScan
            </a>
          )}
        </p>
      </header>

      {!engine.deployed && (
        <Notice title="No engine address for Hedera Testnet">
          <p className="m-0">
            Deploy with <code className="font-mono">yarn foundry:deploy --network hedera_testnet</code>. The deploy
            writes the address and ABI to deployedContracts.ts, and this page reads the engine from there.
          </p>
        </Notice>
      )}

      {engine.deployed && (config.isError || live.isError) && (
        <Notice title="Hedera Testnet did not answer">
          <p className="m-0">
            The engine could not be read through the RPC.{" "}
            <button
              type="button"
              className="link link-primary"
              onClick={() => {
                void config.refetch();
                void live.refetch();
              }}
            >
              Retry
            </button>
          </p>
        </Notice>
      )}

      {engine.deployed && !(config.isError || live.isError) && (!config.data || !live.data) && (
        <div className="flex flex-col gap-10" aria-busy="true" aria-label="Reading the engine">
          <div className="h-80 animate-pulse rounded-box bg-secondary" />
          <div className="h-80 animate-pulse rounded-box bg-secondary" />
        </div>
      )}

      {config.data && live.data && <Loaded snap={{ engine, cfg: config.data, lv: live.data }} />}
    </div>
  );
}

function Loaded({ snap }: { snap: Snapshot }) {
  const { engine, cfg, lv } = snap;
  const ready = useWalletReady();
  const isOwner = !!ready.address && ready.address.toLowerCase() === cfg.owner.toLowerCase();
  const created = isSet(lv.s.token);
  const fuel = runsOfFuel({
    balance: lv.s.balance,
    fuelReserve: cfg.fuelReserve,
    scheduledGas: cfg.scheduledGas,
    gasPriceWei: engine.gasPrice.data,
    costPerRun: engine.lastRunFee.data,
  });

  return (
    <>
      {created ? (
        <>
          <SupplyPanel snap={snap} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <PolicyPanel snap={snap} />
            <EnginePanel snap={snap} />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <RevenuePanel snap={snap} />
            <LockedPanel snap={snap} />
          </div>
        </>
      ) : (
        <Notice title="This engine has no token yet">
          <p className="m-0">
            {isOwner
              ? "Create it below. The engine becomes the token's treasury and sole supply-key holder."
              : "The owner creates the token, then the pool. The supply, policy and engine panels appear here once they exist."}
          </p>
        </Notice>
      )}
      {isOwner && <OwnerControls snap={snap} runs={fuel?.runs} />}
      <ActivityFeed snap={snap} />
    </>
  );
}
