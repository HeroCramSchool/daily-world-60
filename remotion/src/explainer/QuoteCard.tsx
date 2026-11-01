import React from "react";
import { AbsoluteFill, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { fitLines } from "../lib/fit";
import { Stage, BAND, CONTENT_W, SAFE, clamp01, easeOut } from "./Stage";
import type { XVisual } from "../lib/explainerTypes";

const PAD = { top: 96, right: 52, bottom: 52, left: 66 };
const INNER_W = CONTENT_W - PAD.left - PAD.right;
const INNER_FIT_W = Math.round(INNER_W * 0.88);

/** 発言の札。大きな引用符・本文・「— 誰の発言か」。 */
export const QuoteCard: React.FC<{
  visual: Extract<XVisual, { kind: "quote_card" }>;
  local: number;
  instant: boolean;
  accent: string;
}> = ({ visual, local, instant, accent }) => {
  const intro = instant ? Number.MAX_SAFE_INTEGER : local;
  const rise = easeOut(intro, 0, 8);
  const mark = interpolate(intro, [2, 12], [0, 1], { easing: Easing.out(Easing.back(1.6)), ...clamp01 });
  const body = fitLines(visual.text ?? "", INNER_FIT_W, 380, [64, 58, 52, 48, 44, 40, 36, 32, 28], 1.22);
  const who = fitLines(`— ${(visual.who ?? "").toUpperCase()}`, INNER_FIT_W, 96, [40, 36, 32, 28]);

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
            position: "relative", borderRadius: 24, background: "#152447", border: "2px solid rgba(159,179,216,.18)",
            padding: `${PAD.top}px ${PAD.right}px ${PAD.bottom}px ${PAD.left}px`,
            opacity: rise, transform: `translateY(${(1 - rise) * 30}px)`,
          }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 14, background: accent, borderRadius: "24px 0 0 24px" }} />
          <svg
            width={132} height={94} viewBox="5 7 14 10"
            style={{ position: "absolute", left: 60, top: -40, transform: `scale(${mark})`, transformOrigin: "left bottom" }}
          >
            {/* 開き引用符。Inter の “ は細い斜線 2 本に見えるので、ブロック状の形を描く (閉じ引用符を 180° 回す) */}
            <path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z" fill={accent} transform="rotate(180 12 12)" />
          </svg>
          <div style={{ fontWeight: 800, color: "#FFFFFF", fontSize: body.fontSize, lineHeight: `${body.lineHeight}px` }}>
            {body.lines.map((l, i) => <div key={i} style={{ whiteSpace: "nowrap" }}>{l}</div>)}
          </div>
          <div
            style={{
              marginTop: 30, fontWeight: 900, color: accent, letterSpacing: 1,
              fontSize: who.fontSize, lineHeight: `${who.lineHeight}px`,
            }}
          >
            {who.lines.map((l, i) => <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</div>)}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
