import React from "react";
import { AbsoluteFill, interpolate, Easing } from "remotion";
import { MapBg, MapLabels, pinLabelRects, Pin, Label, placeLabels, pushFor, pushed, clamp01, STRIKE, W, H } from "./Stage";
import type { XVisual } from "../lib/explainerTypes";

const APPEAR_F = 10;
const STAGGER_F = 8;
const PULSE_F = 40;
const GAIN = 0.07;

/** 地図がゆっくり寄り、点が1つずつ出る。instant は 0 フレーム目から全部出ている (冒頭とループの戻り)。 */
export const MapZoom: React.FC<{
  visual: Extract<XVisual, { kind: "map_zoom" }>;
  local: number;
  span: number;
  instant: boolean;
}> = ({ visual, local, span, instant }) => {
  const pts = visual.points ?? [];
  const push = pushFor(pts, local, span, GAIN);
  const fin = pushFor(pts, span, span, GAIN);
  const spots = placeLabels(pts.map(p => ({ a: [p.x, p.y] as [number, number], b: pushed(fin, p.x, p.y), text: p.label ?? "" })));
  const intro = instant ? Number.MAX_SAFE_INTEGER : local;

  return (
    <AbsoluteFill>
      <MapBg bg={visual.bg} push={push} />
      <MapLabels labels={visual.labels} push={push} fin={fin} avoid={pinLabelRects(pts, spots, fin)} />
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
        {pts.map((p, i) => {
          const start = 3 + i * STAGGER_F;
          const t = interpolate(intro, [start, start + APPEAR_F], [0, 1], { easing: Easing.out(Easing.back(1.8)), ...clamp01 });
          const lab = interpolate(intro, [start + 4, start + APPEAR_F + 2], [0, 1], clamp01);
          const [x, y] = pushed(push, p.x, p.y);
          const since = instant ? local : local - start;
          const pulse = i === pts.length - 1 ? (Math.max(0, since) % PULSE_F) / PULSE_F : null;
          return (
            <g key={i}>
              <Pin x={x} y={y} t={t} color={STRIKE} pulse={pulse} />
              {p.label ? <Label x={x} y={y} spot={spots[i]} opacity={lab} /> : null}
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
