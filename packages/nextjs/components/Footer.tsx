import React from "react";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { hedera } from "viem/chains";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar/useTargetNetwork";
import { ENGINE_ADDRESS } from "~~/utils/furnace/constants";
import { hashscan } from "~~/utils/furnace/hedera";

/**
 * Site footer
 */
export const Footer = () => {
  const { targetNetwork } = useTargetNetwork();
  const isTestnet = targetNetwork.id !== hedera.id;

  return (
    <div className="mb-11 min-h-0 bg-base-200 px-1 pb-5 text-base-content lg:mb-0">
      <div className="sunset-stripe mb-5" aria-hidden="true" />
      <div>
        <div className="fixed flex justify-between items-center w-full z-10 p-4 bottom-0 left-0 pointer-events-none">
          <div className="flex flex-col md:flex-row gap-2 pointer-events-auto">
            {isTestnet && <HederaPortalFaucet showIcon />}
          </div>
          <SwitchTheme className="pointer-events-auto" />
        </div>
      </div>
      <div className="w-full">
        <ul className="menu menu-horizontal w-full">
          <div className="flex justify-center items-center gap-3 text-sm w-full text-steel">
            <a
              href={hashscan.contract(ENGINE_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="link hover:text-primary hover:underline"
            >
              Engine on HashScan
            </a>
            <span className="opacity-30">|</span>
            <span>
              Built on{" "}
              <a
                href="https://hedera.com/"
                target="_blank"
                rel="noreferrer"
                className="font-semibold link hover:text-primary hover:underline"
              >
                Hedera
              </a>
            </span>
            <span className="opacity-30">|</span>
            <a
              href="https://docs.hedera.com/"
              target="_blank"
              rel="noreferrer"
              className="link hover:text-primary hover:underline"
            >
              Docs
            </a>
          </div>
        </ul>
      </div>
    </div>
  );
};
