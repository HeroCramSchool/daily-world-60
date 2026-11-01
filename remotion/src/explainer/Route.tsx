import React from "react";
import { AbsoluteFill, interpolate, Easing } from "remotion";
import { MapBg, Pin, Label, placeLabels, pushFor, pushed, clamp01, NAVY, STRIKE, W, H } from "./Stage";
import type { XVisual } from "../lib/explainerTypes";

const DRAW_F = 24;
const GAIN = 0.05;

/** 地図の上に from → to の矢印を引く。線は上へ膨らむ二次曲線、矢じりは引き終わりに出す。 */
export const Route: React.FC<{
  visual: Extract<XVisual, { kind: "route" }>;
  local: number;
  span: number;
  instant: boolean;
  accent: string;
}> = ({ visual, local, span, instant, accent }) => {
  const ends = [visual.from, visual.to];
  const push = pushFor(ends, local, span, GAIN);
  const fin = pushFor(ends, span, span, GAIN);
  // 矢印は横から点へ入るので、ラベルは上下を先に試して矢じりと重ねない
  const spots = placeLabels(ends.map(p => ({ a: [p.x, p.y] as [number, number], b: pushed(fin, p.x, p.y), text: p.label ?? "" })), true);
  const intro = instant ? Number.MAX_SAFE_INTEGER : local;

  const [x0, y0] = pushed(push, visual.from.x, visual.from.y);
  const [x2, y2] = pushed(push, visual.to.x, visual.to.y);
  const len = Math.hypot(x2 - x0, y2 - y0);
  const draw = interpolate(intro, [4, 4 + DRAW_F], [0, 1], { easing: Easing.inOut(Easing.cubic), ...clamp01 });
  const head = interpolate(draw, [0.85, 1], [0, 1], clamp01);
  const fromIn = interpolate(intro, [0, 8], [0, 1], { easing: Easing.out(Easing.back(1.8)), ...clamp01 });
  const toIn = interpolate(intro, [4 + DRAW_F - 4, 4 + DRAW_F + 6], [0, 1], { easing: Easing.out(Easing.back(1.8)), ...clamp01 });

  let arrow: React.ReactNode = null;
  if (len > 60) {
    let nx = -(y2 - y0) / len, ny = (x2 - x0) / len;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const bend = Math.min(220, len * 0.3);
    const cx = (x0 + x2) / 2 + nx * bend, cy = (y0 + y2) / 2 + ny * bend;
    const unit = (ax: number, ay: number) => { const l = Math.hypot(ax, ay) || 1; return [ax / l, ay / l]; };
    const [ux, uy] = unit(x2 - cx, y2 - cy);
    const [sx, sy] = unit(cx - x0, cy - y0);
    const tipX = x2 - ux * 22, tipY = y2 - uy * 22;
    const baseX = tipX - ux * 46, baseY = tipY - uy * 46;
    const d = `M ${x0 + sx * 24} ${y0 + sy * 24} Q ${cx} ${cy} ${baseX} ${baseY}`;
    const wing = (k: number) => `${baseX - uy * 28 * k},${baseY + ux * 28 * k}`;
    arrow = draw > 0 ? (
      <g>
        <path d={d} pathLength={1} fill="none" stroke={NAVY} strokeWidth={24} strokeLinecap="round" strokeDasharray="1 1" strokeDashoffset={1 - draw} opacity={0.8} />
        <path d={d} pathLength={1} fill="none" stroke={accent} strokeWidth={12} strokeLinecap="round" strokeDasharray="1 1" strokeDashoffset={1 - draw} />
        <polygon points={`${tipX},${tipY} ${wing(1)} ${wing(-1)}`} fill={accent} stroke={NAVY} strokeWidth={4} strokeLinejoin="round" paintOrder="stroke" opacity={head} />
      </g>
    ) : null;
  }

  return (
    <AbsoluteFill>
      <MapBg bg={visual.bg} push={push} />
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
        {arrow}
        <Pin x={x0} y={y0} t={fromIn} color={accent} pulse={null} />
        <Pin x={x2} y={y2} t={toIn} color={STRIKE} pulse={(Math.max(0, instant ? local : local - 4 - DRAW_F) % 40) / 40} />
        {visual.from.label ? <Label x={x0} y={y0} spot={spots[0]} opacity={interpolate(intro, [2, 10], [0, 1], clamp01)} /> : null}
        {visual.to.label ? <Label x={x2} y={y2} spot={spots[1]} opacity={toIn > 0 ? Math.min(1, toIn) : 0} /> : null}
      </svg>
    </AbsoluteFill>
  );
};
