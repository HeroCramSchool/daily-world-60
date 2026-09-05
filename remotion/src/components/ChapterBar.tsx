import React from "react";
import { T, FONT, SAFE } from "../lib/theme";

interface Props {
  chapters: { heading: string; durationSec: number }[];
  activeIndex: number;
  activeProgress: number;
}

/** 上部の章バー。「今どこか・あと何章か」を常時見せて離脱を抑える。 */
export const ChapterBar: React.FC<Props> = ({ chapters, activeIndex, activeProgress }) => {
  const total = chapters.reduce((a, c) => a + c.durationSec, 0) || 1;
  return (
    <div style={{ position: "absolute", top: 46, left: SAFE, right: SAFE, fontFamily: FONT }}>
      <div style={{ display: "flex", gap: 8, height: 6 }}>
        {chapters.map((c, i) => {
          const fill = i < activeIndex ? 1 : i === activeIndex ? activeProgress : 0;
          return (
            <div
              key={i}
              style={{
                flex: c.durationSec / total,
                background: "rgba(159,179,216,0.20)",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div style={{ width: `${fill * 100}%`, height: "100%", background: T.accent }} />
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          justifyContent: "space-between",
          color: T.dim,
          fontSize: 19,
          fontWeight: 700,
          letterSpacing: 2.4,
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: T.muted }}>
          {String(activeIndex + 1).padStart(2, "0")} · {chapters[activeIndex]?.heading ?? ""}
        </span>
        <span>
          {String(activeIndex + 1).padStart(2, "0")} / {String(chapters.length).padStart(2, "0")}
        </span>
      </div>
    </div>
  );
};
