import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { W, H } from "./Chrome";

export const EYECATCH_SEC = 1.4;

/**
 * アイキャッチ (ブランドスティング)。フックと本文の切れ目に 0.8 秒だけ挟む。
 * ナレーションはここで一度切って再開するので、字幕の同期は音声側のオフセットで吸収する。
 *
 * 動き: 黒へ切替 → 黄色の帯が左から伸びる → ワードマークが出る → **静止して見せる** →
 * 帯ごと右へ抜ける。
 *
 * 0.8 秒では見落とされた (2026-09-07 オーナー指摘)。原因は尺そのものより「静止(hold)が
 * 無く、出た瞬間に抜け始めていた」こと。1.4 秒に伸ばし、うち約 0.6 秒を静止に充てる。
 * 冒頭には置かない (ショートは最初の 1 秒で離脱が決まるため、フックを遅らせない)。
 */
export const EyeCatch: React.FC<{ accent: string }> = ({ accent }) => {
  const f = useCurrentFrame();

  // 帯: 左から伸びて、最後に右へ抜ける
  const grow = interpolate(f, [0, 8], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 8-30f は静止 (ここが無いと一瞬で消えて読めない)
  const leave = interpolate(f, [32, 42], [0, 1], { easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bandX = leave * W * 1.2;

  const wordIn = interpolate(f, [6, 15], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const flash = interpolate(f, [4, 9], [0.35, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const BAND_H = 240;
  const bandY = H / 2 - BAND_H / 2;

  return (
    <AbsoluteFill style={{ background: "#08090C", fontFamily: FONT }}>
      <Audio src={staticFile("sfx/eyecatch.mp3")} volume={0.5} />

      {/* 細い上下のガイド線 (帯より一拍早く出る) */}
      {[bandY - 46, bandY + BAND_H + 46].map((y, i) => (
        <div
          key={i}
          style={{
            position: "absolute", left: 0, top: y, height: 4, background: accent,
            width: W * interpolate(f, [i * 2, i * 2 + 10], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            opacity: 0.55, transform: `translateX(${bandX}px)`,
          }}
        />
      ))}

      <div
        style={{
          position: "absolute", left: 0, top: bandY, width: W, height: BAND_H, background: accent,
          transform: `translateX(${bandX}px) scaleX(${grow})`, transformOrigin: "left center",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div
          style={{
            // 帯の scaleX を打ち消して文字の横比を保つ
            transform: `scaleX(${1 / Math.max(grow, 0.001)})`,
            display: "flex", alignItems: "baseline", gap: 18,
            opacity: wordIn,
          }}
        >
          <span style={{ fontWeight: 900, fontSize: 78, color: "#08090C", letterSpacing: -2 }}>DAILY WORLD</span>
          <span style={{ fontWeight: 900, fontSize: 100, color: "#08090C", letterSpacing: -3 }}>60</span>
        </div>
      </div>

      <AbsoluteFill style={{ background: "#fff", opacity: flash, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
