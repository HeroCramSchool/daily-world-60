import React from "react";
import { T, FONT, SAFE } from "../lib/theme";

export const BrandMark: React.FC<{ opacity?: number }> = ({ opacity = 0.55 }) => (
  <div
    style={{
      position: "absolute",
      left: SAFE,
      bottom: 44,
      display: "flex",
      alignItems: "center",
      gap: 12,
      opacity,
      fontFamily: FONT,
    }}
  >
    <div style={{ width: 10, height: 26, background: T.accent }} />
    <div style={{ color: T.muted, fontSize: 20, fontWeight: 800, letterSpacing: 3 }}>
      DAILY WORLD 60
    </div>
  </div>
);
