import React from "react";
import { interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { fitSize } from "../lib/fit";
import type { SWord } from "../lib/shortTypes";

// 元の captionSvg は 1150..1670 の固定箱だった。チャンクを短くした結果 1 行のことが多く、
// 固定高だと下が空く。中心 (1410) を保ったまま内容に合わせて伸縮させる。
const BOX = { x: 40, cy: 1410, w: 1000, maxH: 520 };

/**
 * 本文字幕。発話中の語をアクセント色にする。
 * ffmpeg 版は「語ごとに SVG を作って concat」していたが、ここは1コンポーネントで
 * 実時間から色を決めるだけ。表示語 = 発話語なのでリサンプリングによるズレが出ない。
 */
export const Caption: React.FC<{
  words: SWord[];
  time: number;   // 動画先頭からの秒
  local: number;  // チャンク先頭からのフレーム
  accent: string;
  fps: number;
}> = ({ words, time, local, accent, fps }) => {
  const text = words.map(w => w.w).join(" ");
  const fontSize = fitSize(text, 840, BOX.maxH - 80, [56, 50, 46, 42, 38, 34]);
  const rise = interpolate(local, [0, 6], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute", left: BOX.x, top: BOX.cy, width: BOX.w,
        transform: "translateY(-50%)",
        background: "rgba(10,10,10,.82)", borderRadius: 20,
        display: "flex", alignItems: "stretch", padding: "44px 50px",
        opacity: rise,
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 14, background: accent, borderRadius: 7 }} />
      <div
        style={{
          flex: 1,
          display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "baseline",
          gap: `${Math.round(fontSize * 0.18)}px ${Math.round(fontSize * 0.28)}px`,
          fontFamily: FONT, fontWeight: 900, fontSize, lineHeight: 1.18, textAlign: "center",
        }}
      >
        {words.map((w, i) => {
          const on = time >= w.t && time < w.t + w.d;
          return (
            <span
              key={i}
              style={{
                color: on ? accent : "#fff",
                display: "inline-block",
                textShadow: on ? `0 0 24px ${accent}55` : "none",
              }}
            >
              {w.w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** フック / 問いかけ / アウトロで使う大きな文字ブロック。 */
export const BigText: React.FC<{
  text: string; local: number; fps: number;
  maxSize: number[]; boxW: number; boxH: number;
  color?: string; align?: "left" | "center";
}> = ({ text, local, maxSize, boxW, boxH, color = "#fff", align = "left" }) => {
  const size = fitSize(text, boxW, boxH, maxSize, 1.1);
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", gap: `${Math.round(size * 0.06)}px ${Math.round(size * 0.24)}px`,
        justifyContent: align === "center" ? "center" : "flex-start",
        fontFamily: FONT, fontWeight: 900, fontSize: size, lineHeight: 1.06, letterSpacing: -1, color,
      }}
    >
      {words.map((w, i) => {
        const rise = interpolate(local, [i * 2, i * 2 + 10], [0, 1], {
          easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        return (
          <span key={i} style={{ opacity: rise, transform: `translateY(${(1 - rise) * 26}px)`, display: "inline-block" }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};
