import React from "react";
import { AbsoluteFill, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { EM, fitLines } from "../lib/fit";
import { Stage, BAND, CONTENT_W, FIT_W, SAFE, clamp01 } from "./Stage";
import { decimalsOf, fmtNum } from "./Counter";
import type { XVisual } from "../lib/explainerTypes";

const GROW_F = 18;
const STAGGER_F = 5;

/** 2〜4 本の横棒。長さは最大値に対する比、値の札は棒の先に付いて一緒に伸びる。 */
export const Bars: React.FC<{
  visual: Extract<XVisual, { kind: "bars" }>;
  local: number;
  instant: boolean;
  accent: string;
}> = ({ visual, local, instant, accent }) => {
  const intro = instant ? Number.MAX_SAFE_INTEGER : local;
  const items = (visual.items ?? []).slice(0, 4);
  const n = Math.max(1, items.length);
  const barH = n <= 2 ? 96 : n === 3 ? 80 : 64;
  const max = Math.max(0, ...items.map(it => it.value)) || 1;
  const d = Math.max(0, ...items.map(it => decimalsOf(it.value)));
  const valSize = Math.round(barH * 0.62);
  const valW = Math.max(0, ...items.map(it => EM(fmtNum(it.value, d)) * valSize * 1.12));
  const trackW = CONTENT_W - valW - 28;
  // ラベルの文字サイズは全行でそろえる。最小でも収まらない行だけ末尾を省く
  const labelSize = Math.min(...items.map(it => fitLines((it.label ?? "").toUpperCase(), FIT_W, 52, [44, 40, 36, 32]).fontSize));

  return (
    <AbsoluteFill>
      <Stage />
      <div
        style={{
          position: "absolute", left: SAFE.left, top: BAND.top, width: CONTENT_W, height: BAND.bottom - BAND.top,
          display: "flex", flexDirection: "column", justifyContent: "center", gap: n === 4 ? 34 : 46, fontFamily: FONT,
        }}
      >
        {items.map((it, i) => {
          const g = interpolate(intro, [3 + i * STAGGER_F, 3 + i * STAGGER_F + GROW_F], [0, 1], { easing: Easing.out(Easing.cubic), ...clamp01 });
          const fillW = Math.max(10, trackW * (Math.max(0, it.value) / max) * g);
          return (
            <div key={i} style={{ opacity: interpolate(intro, [i * STAGGER_F, i * STAGGER_F + 6], [0, 1], clamp01) }}>
              <div
                style={{
                  fontWeight: 900, color: "rgba(255,255,255,.88)", letterSpacing: 1,
                  fontSize: labelSize, lineHeight: `${Math.round(labelSize * 1.16)}px`,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 12,
                }}
              >
                {(it.label ?? "").toUpperCase()}
              </div>
              <div style={{ position: "relative", height: barH }}>
                <div style={{ position: "absolute", left: 0, top: 0, width: trackW, height: barH, borderRadius: 12, background: "rgba(159,179,216,.14)" }} />
                <div style={{ position: "absolute", left: 0, top: 0, width: fillW, height: barH, borderRadius: 12, background: accent }} />
                <div
                  style={{
                    position: "absolute", left: fillW + 20, top: 0, height: barH, display: "flex", alignItems: "center",
                    fontWeight: 900, fontSize: valSize, color: "#FFFFFF", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                  }}
                >
                  {fmtNum(it.value * g, d)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
