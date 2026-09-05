import React from "react";
import { T, FONT, SAFE } from "../lib/theme";
import type { Source } from "../lib/types";

/** 出典の下三分の一チップ。数字を出す動画では出典の常時表示が信頼に直結する。 */
export const SourceChip: React.FC<{ source: Source | null; opacity?: number }> = ({ source, opacity = 1 }) => {
  if (!source) return null;
  return (
    <div
      style={{
        position: "absolute",
        right: SAFE,
        bottom: 44,
        opacity,
        fontFamily: FONT,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "rgba(6,11,21,0.72)",
        border: `1px solid ${T.rule}`,
        borderRadius: 999,
        padding: "10px 20px",
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: 999, background: T.accent }} />
      <span style={{ color: T.dim, fontSize: 17, fontWeight: 700, letterSpacing: 2 }}>SOURCE</span>
      <span style={{ color: T.muted, fontSize: 19, fontWeight: 700 }}>{source.name}</span>
    </div>
  );
};
