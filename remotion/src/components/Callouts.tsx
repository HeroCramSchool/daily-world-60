import React from "react";
import { useVideoConfig, interpolate } from "remotion";
import { T, FONT } from "../lib/theme";
import { enter as enterAnim } from "../lib/anim";
import type { Callout } from "../lib/types";

const HOLD = 4.6;

/**
 * 数値が読み上げられた瞬間に出るカード。
 *
 * 数字はカウントアップさせない。途中フレームに実在しない値 (2.8% の途中の 1.3% 等) が
 * 映り、切り取られると誤情報になるため。動きは不透明度と位置だけが担当する。
 * ラベルはナレーション原文の直前5語をそのまま使う (言い換えない)。
 */
export const Callouts: React.FC<{ callouts: Callout[]; timeSec: number; top: number; left: number }> = ({
  callouts,
  timeSec,
  top,
  left,
}) => {
  const { fps } = useVideoConfig();

  const live = callouts
    .map((c, i) => ({ c, i, age: timeSec - c.t }))
    .filter(x => x.age >= 0 && x.age <= HOLD)
    .slice(-2);

  return (
    <div style={{ position: "absolute", top, left, display: "flex", flexDirection: "column", gap: 20, fontFamily: FONT }}>
      {live.map(({ c, i, age }, slot) => {
        const enter = enterAnim(age * fps);
        const exit = interpolate(age, [HOLD - 0.45, HOLD], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const isOld = slot < live.length - 1;
        const accent = c.kind === "delta" ? T.hot : T.accent;

        return (
          <div
            key={i}
            style={{
              opacity: exit * enter * (isOld ? 0.4 : 1),
              transform: `translateX(${(1 - enter) * -40}px) scale(${isOld ? 0.76 : 1})`,
              transformOrigin: "left center",
              display: "flex",
              alignItems: "stretch",
              gap: 18,
            }}
          >
            <div style={{ width: 8, background: accent, borderRadius: 4 }} />
            <div
              style={{
                background: "rgba(6,11,21,0.82)",
                border: `1px solid ${T.rule}`,
                borderRadius: 16,
                padding: "20px 32px",
                minWidth: 320,
                maxWidth: 660,
              }}
            >
              {c.label ? (
                <div
                  style={{
                    color: T.muted,
                    fontSize: 24,
                    fontWeight: 700,
                    letterSpacing: 1.4,
                    marginBottom: 10,
                    textTransform: "uppercase",
                  }}
                >
                  {c.label}
                </div>
              ) : null}

              {c.kind === "delta" && c.from ? (
                <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 62, fontWeight: 800, color: T.dim, textDecoration: "line-through", fontVariantNumeric: "tabular-nums" }}>
                    {c.from}
                  </span>
                  <span style={{ fontSize: 48, fontWeight: 900, color: accent }}>→</span>
                  <span style={{ fontSize: 92, fontWeight: 900, color: accent, letterSpacing: -2, fontVariantNumeric: "tabular-nums" }}>
                    {c.display}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 104, fontWeight: 900, color: accent, lineHeight: 1, letterSpacing: -2, fontVariantNumeric: "tabular-nums" }}>
                  {c.display}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
