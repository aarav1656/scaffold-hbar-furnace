import { useEffect, useRef, useState } from "react";
import { fmtUnits } from "~~/utils/furnace/format";
import type { SupplyPoint } from "~~/utils/furnace/supply";

const MONO = "var(--font-jetbrains-mono), ui-monospace, monospace";

/** Container width in pixels, tracked so the chart draws at its real size and its text never scales down. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Largest 1, 2 or 5 x 10^k at or below `raw`. */
function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * pow;
}

const whole = (value: bigint, decimals: number) => Number(value) / 10 ** decimals;

/**
 * Supply against time. The line holds its level between burns and drops straight down at each one; the heat
 * band above it, yellow at the maximum and ember at the deepest level, is the supply already burned away.
 */
export function SupplyChart({
  points,
  maxSupply,
  decimals,
  selected,
  onSelect,
}: {
  points: SupplyPoint[];
  maxSupply: bigint;
  decimals: number;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [ref, width] = useWidth();
  const compact = width < 520;
  const height = compact ? 260 : 340;

  const supplies = points.map(p => whole(p.supply, decimals));
  const top = Math.max(whole(maxSupply, decimals), ...supplies);
  const min = Math.min(...supplies);
  const pad = Math.max(top - min, top * 0.02);
  const step = niceStep((top - Math.max(0, min - pad)) / 4);
  const bottom = Math.max(0, Math.floor((min - pad) / step) * step);
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step * 1e-9; v += step) ticks.push(v);
  const labels = ticks.map(v => fmtUnits(BigInt(Math.round(v)) * 10n ** BigInt(decimals), decimals, 0));

  const left = Math.max(...labels.map(l => l.length)) * 6.8 + 16;
  const right = 14;
  const topPad = 14;
  const bottomPad = 30;
  const plotW = Math.max(width - left - right, 1);
  const plotH = height - topPad - bottomPad;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : plotW);
  const y = (v: number) => topPad + (1 - (v - bottom) / (top - bottom)) * plotH;

  // Hold the previous level until each point's time, then drop to its level.
  const path = points
    .map((p, i) => {
      const px = x(p.t).toFixed(1);
      const py = y(supplies[i]).toFixed(1);
      return i === 0 ? `M${px} ${py}` : `H${px} V${py}`;
    })
    .join(" ");
  const yEnd = y(supplies[supplies.length - 1]);
  const yMax = y(whole(maxSupply, decimals));

  const timeLabel = (t: number) => {
    const d = new Date(t * 1000);
    return t1 - t0 > 36 * 3600
      ? d.toLocaleDateString([], { month: "short", day: "numeric" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  const tickCount = compact ? 3 : 5;
  const xTicks = Array.from({ length: tickCount }, (_, i) => t0 + ((t1 - t0) * i) / (tickCount - 1));

  const burnIdx = points.flatMap((p, i) => (p.burn ? [i] : []));
  const nearest = (clientX: number, box: DOMRect) => {
    const px = clientX - box.left;
    let best = burnIdx[0];
    for (const i of burnIdx) if (Math.abs(x(points[i].t) - px) < Math.abs(x(points[best].t) - px)) best = i;
    if (best !== undefined) onSelect(best);
  };

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Supply over time, ${points.length - 1} steps, from ${supplies[0].toLocaleString()} to ${supplies[supplies.length - 1].toLocaleString()} tokens`}
          className="block touch-pan-y select-none"
          onPointerMove={e => nearest(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={e => nearest(e.clientX, e.currentTarget.getBoundingClientRect())}
        >
          <defs>
            <linearGradient
              id="burned-heat"
              gradientUnits="userSpaceOnUse"
              x1="0"
              x2="0"
              y1={yMax}
              y2={Math.max(y(min), yMax + 1)}
            >
              <stop offset="0%" stopColor="var(--burn-fill-top)" />
              <stop offset="100%" stopColor="var(--burn-fill-bottom)" />
            </linearGradient>
          </defs>
          <rect
            x={left}
            y={yMax}
            width={plotW}
            height={Math.max(plotH - (yMax - topPad), 0)}
            fill="url(#burned-heat)"
          />
          <path d={`${path} V${topPad + plotH} H${left} Z`} fill="var(--color-base-100)" stroke="none" />
          {ticks.map((v, i) => (
            <g key={v}>
              <line
                x1={left}
                x2={left + plotW}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--color-base-300)"
                strokeWidth={1}
                opacity={0.6}
              />
              <text x={left - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fontFamily={MONO} fill="var(--text-steel)">
                {labels[i]}
              </text>
            </g>
          ))}
          <line
            x1={left}
            x2={left + plotW}
            y1={yMax}
            y2={yMax}
            stroke="var(--color-base-content)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <text x={left + plotW} y={yMax - 5} textAnchor="end" fontSize={11} fontFamily={MONO} fill="var(--text-slate)">
            max supply
          </text>
          <path
            d={path}
            fill="none"
            stroke="var(--color-base-content)"
            strokeWidth={2.5}
            strokeLinejoin="round"
            pathLength={1}
            className="draw-line"
          />
          <line
            x1={x(points[selected].t)}
            x2={x(points[selected].t)}
            y1={topPad}
            y2={topPad + plotH}
            stroke="var(--color-base-content)"
            strokeWidth={1}
            opacity={0.5}
          />
          {burnIdx.map(i => (
            <circle
              key={i}
              cx={x(points[i].t)}
              cy={y(supplies[i])}
              r={i === selected ? 5.5 : 3.5}
              fill={i === selected ? "var(--color-primary)" : "var(--color-base-100)"}
              stroke="var(--color-base-content)"
              strokeWidth={2}
            />
          ))}
          <circle
            cx={x(t1)}
            cy={yEnd}
            r={4}
            fill="var(--color-primary)"
            stroke="var(--color-base-100)"
            strokeWidth={2}
          />
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={Math.min(Math.max(x(t), left), left + plotW)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              fontSize={11}
              fontFamily={MONO}
              fill="var(--text-steel)"
            >
              {i === xTicks.length - 1 ? "now" : timeLabel(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}
