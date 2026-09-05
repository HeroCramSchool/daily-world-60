import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Captions } from "../components/Captions";
import { Callouts } from "../components/Callouts";
import { SourceChip } from "../components/SourceChip";
import { ChapterBar } from "../components/ChapterBar";
import { T, FONT, SAFE } from "../lib/theme";
import { pop } from "../lib/anim";
import type { Segment } from "../lib/types";

interface Props {
  seg: Segment;
  chapters: { heading: string; durationSec: number }[];
  chapterIndex: number;
}

/** 本編。写真は右のカードに固定して置き (ズーム・パンなし)、
 *  動きは「カードの入場・見出し・数値カード・字幕」だけが担当する。 */
export const Section: React.FC<Props> = ({ seg, chapters, chapterIndex }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const headIn = pop(frame, fps, 2);
  const cardIn = pop(frame, fps, 7);
  const chipIn = interpolate(t, [0.7, 1.4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const CARD_W = 856;
  const CARD_H = 566;
  const CARD_X = width - SAFE - CARD_W;

  return (
    <Backdrop>
      <ChapterBar
        chapters={chapters}
        activeIndex={chapterIndex}
        activeProgress={Math.min(1, t / Math.max(0.001, seg.durationSec))}
      />

      {/* 見出し */}
      <div
        style={{
          position: "absolute",
          top: 168,
          left: SAFE,
          width: 780,
          fontFamily: FONT,
          opacity: headIn,
          transform: `translateY(${(1 - headIn) * 22}px)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <div style={{ width: 8, height: 46, background: T.accent }} />
          <div style={{ fontSize: 40, fontWeight: 900, color: T.accent, letterSpacing: -1 }}>
            {String(chapterIndex + 1).padStart(2, "0")}
          </div>
        </div>
        <div
          style={{
            fontSize: seg.heading.length > 24 ? 62 : 74,
            fontWeight: 900,
            color: T.ink,
            lineHeight: 1.08,
            letterSpacing: -1.6,
          }}
        >
          {seg.heading}
        </div>
      </div>

      {/* 写真カード (静止・トリミングのみ) */}
      {seg.bg ? (
        <div
          style={{
            position: "absolute",
            top: 152,
            left: CARD_X,
            width: CARD_W,
            height: CARD_H,
            borderRadius: 22,
            overflow: "hidden",
            border: `1px solid ${T.rule}`,
            boxShadow: "0 30px 90px rgba(0,0,0,0.55)",
            opacity: cardIn,
            transform: `translateX(${(1 - cardIn) * 54}px)`,
          }}
        >
          <Img
            src={staticFile(seg.bg)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(180deg, rgba(11,18,32,0.05) 40%, rgba(11,18,32,0.62) 100%)",
            }}
          />
        </div>
      ) : null}

      <Callouts callouts={seg.callouts} timeSec={t} top={430} left={SAFE} />

      <Captions lines={seg.lines} words={seg.words} timeSec={t} bottom={104} maxWidth={1500} />
      <SourceChip source={seg.source} opacity={chipIn} />
    </Backdrop>
  );
};
