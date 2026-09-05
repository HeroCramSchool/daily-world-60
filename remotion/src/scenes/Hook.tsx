import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { BrandMark } from "../components/Brand";
import { Captions } from "../components/Captions";
import { T, FONT, SAFE } from "../lib/theme";
import { pop } from "../lib/anim";
import type { Segment } from "../lib/types";

/** 冒頭。前半はフックを画面中央に大きく出し、後半でタイトルを立ち上げる。
 *  無音のタイトルカードを挟まないので、頭の数秒に死に時間が生まれない。 */
export const Hook: React.FC<{ seg: Segment; title: string; topic: string }> = ({ seg, title, topic }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const turn = seg.durationSec * 0.56;
  const toTitle = interpolate(t, [turn, turn + 0.55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const line = seg.lines.find(l => t >= l.start - 0.12 && t <= l.end + 0.34);
  const spoken = line ? seg.words.filter(w => w.t >= line.start - 0.05 && w.t <= line.end + 0.05) : [];

  const titleIn = pop(frame - turn * fps, fps);
  const rule = interpolate(titleIn, [0, 1], [0, 1]);

  return (
    <Backdrop>
      <div
        style={{
          position: "absolute",
          top: 54,
          left: SAFE,
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontFamily: FONT,
          opacity: 0.9,
        }}
      >
        <div style={{ width: 10, height: 24, background: T.accent }} />
        <span style={{ color: T.accent, fontSize: 22, fontWeight: 900, letterSpacing: 6 }}>
          DEEP DIVE
        </span>
        <span style={{ color: T.dim, fontSize: 22, fontWeight: 700, letterSpacing: 3 }}>
          · {topic.toUpperCase()}
        </span>
      </div>

      {/* 前半: フックを大きく */}
      <AbsoluteFill
        style={{
          opacity: 1 - toTitle,
          alignItems: "center",
          justifyContent: "center",
          padding: `0 ${SAFE + 60}px`,
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            display: "flex",
            flexWrap: "wrap",
            gap: "0 18px",
            justifyContent: "center",
            lineHeight: 1.22,
          }}
        >
          {spoken.map((w, i) => {
            const active = t >= w.t && t <= w.t + w.d + 0.06;
            return (
              <span key={i} style={{ fontSize: 82, fontWeight: 900, color: active ? T.accent : T.ink }}>
                {w.w}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>

      {/* 後半: タイトル */}
      <AbsoluteFill
        style={{
          opacity: toTitle,
          alignItems: "flex-start",
          justifyContent: "center",
          padding: `0 ${SAFE}px`,
        }}
      >
        <div style={{ fontFamily: FONT, maxWidth: 1560 }}>
          <div
            style={{
              height: 10,
              width: `${rule * 240}px`,
              background: T.accent,
              marginBottom: 38,
            }}
          />
          <div
            style={{
              fontSize: title.length > 64 ? 78 : 94,
              fontWeight: 900,
              color: T.ink,
              lineHeight: 1.1,
              letterSpacing: -1.5,
              transform: `translateY(${(1 - titleIn) * 26}px)`,
            }}
          >
            {title}
          </div>
        </div>
      </AbsoluteFill>

      <div style={{ opacity: toTitle }}>
        <Captions lines={seg.lines} words={seg.words} timeSec={t} bottom={96} maxWidth={1360} />
      </div>
      <BrandMark opacity={0.4} />
    </Backdrop>
  );
};
