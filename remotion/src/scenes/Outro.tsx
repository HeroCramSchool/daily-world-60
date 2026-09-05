import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { BrandMark } from "../components/Brand";
import { Captions } from "../components/Captions";
import { T, FONT, SAFE } from "../lib/theme";
import { pop } from "../lib/anim";
import type { Segment } from "../lib/types";

/** 締め。問いかけを大きく出してコメントを促す (ショート側と同じ導線)。 */
export const Outro: React.FC<{ seg: Segment }> = ({ seg }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const qIn = pop(frame, fps, 6);
  const ruleW = interpolate(qIn, [0, 1], [0, 300]);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "flex-start", justifyContent: "center", padding: `0 ${SAFE}px` }}>
        <div style={{ fontFamily: FONT, maxWidth: 1520 }}>
          <div style={{ height: 10, width: ruleW, background: T.accent, marginBottom: 34 }} />
          <div
            style={{
              fontSize: 92,
              fontWeight: 900,
              color: T.ink,
              lineHeight: 1.08,
              letterSpacing: -2,
              opacity: qIn,
              transform: `translateY(${(1 - qIn) * 24}px)`,
            }}
          >
            What do you think
            <br />
            about this?
          </div>
          <div
            style={{
              marginTop: 34,
              fontSize: 34,
              fontWeight: 700,
              color: T.muted,
              opacity: interpolate(t, [1.2, 2.0], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            Tell us in the comments — and subscribe for one deep dive a week.
          </div>
        </div>
      </AbsoluteFill>

      <Captions lines={seg.lines} words={seg.words} timeSec={t} bottom={96} maxWidth={1360} />
      <BrandMark opacity={0.5} />
    </Backdrop>
  );
};
