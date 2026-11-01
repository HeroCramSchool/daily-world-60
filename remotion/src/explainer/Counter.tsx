import React from "react";
import { AbsoluteFill, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { EM, fitLines } from "../lib/fit";
import { Stage, BAND, CONTENT_W, FIT_W, SAFE, clamp01, easeOut } from "./Stage";
import type { XVisual } from "../lib/explainerTypes";

const COUNT_F = 24;

export const decimalsOf = (n: number) => {
  const s = String(Math.abs(n));
  const i = s.indexOf(".");
  return i < 0 || s.includes("e") ? 0 : Math.min(2, s.length - i - 1);
};
export const fmtNum = (n: number, d: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** 大きな数字が約 0.8 秒で数え上がる。等幅数字なので数えている間に幅が揺れない。 */
export const Counter: React.FC<{
  visual: Extract<XVisual, { kind: "counter" }>;
  local: number;
  instant: boolean;
  accent: string;
}> = ({ visual, local, instant, accent }) => {
  const intro = instant ? Number.MAX_SAFE_INTEGER : local;
  const d = decimalsOf(visual.value);
  const final = fmtNum(visual.value, d);
  const p = interpolate(intro, [2, 2 + COUNT_F], [0, 1], { easing: Easing.out(Easing.cubic), ...clamp01 });
  const size = Math.min(300, Math.floor(FIT_W / (EM(final) * 1.1)));
  const label = fitLines((visual.label ?? "").toUpperCase(), FIT_W, 200, [64, 58, 52, 46, 42, 38, 34, 30]);
  const rule = easeOut(intro, 4, 14);

  return (
    <AbsoluteFill>
      <Stage />
      <div
        style={{
          position: "absolute", left: SAFE.left, top: BAND.top, width: CONTENT_W, height: BAND.bottom - BAND.top,
          display: "flex", flexDirection: "column", justifyContent: "center", fontFamily: FONT,
        }}
      >
        <div
          style={{
            fontWeight: 900, fontSize: size, lineHeight: 1, letterSpacing: -4, color: accent,
            fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
            textShadow: `0 0 40px ${accent}40`,
          }}
        >
          {fmtNum(visual.value * p, d)}
        </div>
        <div style={{ width: 300, height: 12, marginTop: 26, borderRadius: 6, background: accent, transform: `scaleX(${rule})`, transformOrigin: "left" }} />
        <div
          style={{
            marginTop: 30, fontWeight: 900, color: "#FFFFFF", letterSpacing: 1,
            fontSize: label.fontSize, lineHeight: `${label.lineHeight}px`,
            maxHeight: 200, overflow: "hidden", opacity: easeOut(intro, 6, 10),
          }}
        >
          {label.lines.map((l, i) => <div key={i} style={{ whiteSpace: "nowrap" }}>{l}</div>)}
        </div>
      </div>
    </AbsoluteFill>
  );
};
