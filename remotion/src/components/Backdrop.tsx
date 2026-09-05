import React from "react";
import { AbsoluteFill } from "remotion";
import { T } from "../lib/theme";

/** ブランド地。写真はここには敷かない (ズーム/パンを一切使わない方針のため、
 *  写真は Section 側の固定カードに収める)。動きは前景の要素だけが担当する。 */
export const Backdrop: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: T.bg }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 22% 8%, ${T.bgLift} 0%, ${T.bg} 62%)`,
      }}
    />
    {children}
    <AbsoluteFill
      style={{
        boxShadow: "inset 0 0 260px 90px rgba(0,0,0,0.55)",
        pointerEvents: "none",
      }}
    />
  </AbsoluteFill>
);
