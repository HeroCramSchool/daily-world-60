import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, interpolate } from "remotion";
import { FONT } from "../lib/theme";
import { fitLines } from "../lib/fit";

export const W = 1080;
export const H = 1920;

/** 背景の絵。ズーム・パンはしない (オーナー指示)。切り替わりだけ 0.22s のフェードで繋ぐ。 */
export const Backplate: React.FC<{
  bg: string | null;
  motion: string | null;
  motionSeek?: number;
  local: number;
  fadeIn: boolean;
  fps: number;
}> = ({ bg, motion, motionSeek = 0, local, fadeIn, fps }) => {
  const o = fadeIn
    ? interpolate(local, [0, 0.22 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      {motion ? (
        <OffthreadVideo
          src={staticFile(motion)}
          trimBefore={Math.round(motionSeek * fps)}
          muted
          style={{ width: W, height: H, objectFit: "cover" }}
        />
      ) : bg ? (
        <Img src={staticFile(bg)} style={{ width: W, height: H, objectFit: "cover" }} />
      ) : (
        <AbsoluteFill style={{ background: "#0A0A0A" }} />
      )}
    </AbsoluteFill>
  );
};

/** 本文シーンの暗幕。上下を締めて中央を残す (captionSvg の darken と同じ配分)。 */
export const Scrim: React.FC<{ variant: "body" | "hook" | "map" }> = ({ variant }) => (
  <AbsoluteFill
    style={{
      background:
        // 地図は元から暗い紺地なので、写真用の暗幕を掛けると赤マーカーと黄カウンターが沈む。
        // 見出しと字幕の帯だけ軽く締める。
        variant === "map"
          ? "linear-gradient(180deg, rgba(10,10,10,.80) 0%, rgba(10,10,10,.30) 20%, rgba(10,10,10,0) 28%, rgba(10,10,10,0) 60%, rgba(10,10,10,.55) 78%, rgba(10,10,10,.92) 100%)"
          : variant === "hook"
          ? "linear-gradient(180deg, rgba(10,10,10,.35) 0%, rgba(10,10,10,.12) 45%, rgba(10,10,10,.55) 62%, rgba(10,10,10,.94) 100%)"
          : "linear-gradient(180deg, rgba(10,10,10,.92) 0%, rgba(10,10,10,.50) 22%, rgba(10,10,10,.55) 68%, rgba(10,10,10,.95) 100%)",
    }}
  />
);

export const TopStripe: React.FC = () => (
  <div style={{ position: "absolute", top: 0, left: 0, width: W, height: 60, background: "#F5E63B" }} />
);

export const SourceFooter: React.FC<{ name: string; url: string }> = ({ name, url }) => (
  <div
    style={{
      position: "absolute", left: 60, bottom: 64, right: 60,
      fontFamily: FONT, color: "rgba(255,255,255,.62)", fontSize: 26, fontWeight: 600,
      letterSpacing: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    }}
  >
    SOURCE · {name}{url ? `  ${url}` : ""}
  </div>
);

/** 見出し (本文シーンの上部)。SVG 版と同じ 60,200 起点・960 幅。 */
export const Headline: React.FC<{ text: string }> = ({ text }) => {
  const fit = fitLines(text, 960, 260, [52, 46, 42, 38, 34, 30, 28, 24]);
  return (
    <div
      style={{
        position: "absolute", left: 60, top: 200, width: 960,
        fontFamily: FONT, fontWeight: 900, color: "#fff",
        fontSize: fit.fontSize, lineHeight: `${fit.lineHeight}px`, letterSpacing: -1,
      }}
    >
      {fit.lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
};

export const CountryLine: React.FC<{ name: string; accent: string }> = ({ name, accent }) => (
  <div
    style={{
      position: "absolute", left: 60, top: 118, width: 960,
      fontFamily: FONT, fontWeight: 900, color: accent, fontSize: 40, letterSpacing: 6,
      whiteSpace: "nowrap", overflow: "hidden",
    }}
  >
    {name}
  </div>
);
