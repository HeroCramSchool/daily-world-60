import React from "react";
import { T, FONT, SAFE } from "../lib/theme";
import type { Line, Word } from "../lib/types";

interface Props {
  lines: Line[];
  words: Word[];
  timeSec: number;
  bottom?: number;
  maxWidth?: number;
}

/** 発話中の語をアクセント色にするカラオケ字幕。単語タイムスタンプがあるので
 *  「今どこを言っているか」が一致し、読み流されにくい。 */
export const Captions: React.FC<Props> = ({ lines, words, timeSec, bottom = 108, maxWidth = 1500 }) => {
  const line = lines.find(l => timeSec >= l.start - 0.12 && timeSec <= l.end + 0.34);
  if (!line) return null;
  const spoken = words.filter(w => w.t >= line.start - 0.05 && w.t <= line.end + 0.05);

  return (
    <div
      style={{
        position: "absolute",
        bottom,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        fontFamily: FONT,
        padding: `0 ${SAFE}px`,
      }}
    >
      <div
        style={{
          maxWidth,
          background: "rgba(6,11,21,0.82)",
          border: `1px solid ${T.rule}`,
          borderRadius: 14,
          padding: "20px 34px",
          display: "flex",
          flexWrap: "wrap",
          gap: "0 13px",
          justifyContent: "center",
          lineHeight: 1.28,
        }}
      >
        {spoken.map((w, i) => {
          const active = timeSec >= w.t && timeSec <= w.t + w.d + 0.06;
          return (
            <span
              key={i}
              style={{
                fontSize: 42,
                fontWeight: active ? 900 : 600,
                color: active ? T.accent : T.ink,
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
