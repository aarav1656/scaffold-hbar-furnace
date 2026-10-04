import type { Metadata } from "next";
import { FurnaceView } from "~~/components/furnace/FurnaceView";

export const metadata: Metadata = {
  title: { absolute: "Furnace: supply falling, budget and price ceiling, next burn, send revenue" },
};

export default function Home() {
  return <FurnaceView />;
}
