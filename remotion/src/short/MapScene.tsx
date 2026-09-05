import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { W, H } from "./Chrome";
import type { SMapMarker } from "../lib/shortTypes";

/**
 * 地図シーン。背景 (紺地/グリッド/陸ドット/バッジ) は prep が焼いた PNG、
 * マーカーだけをフレームで動かす。
 *
 * ffmpeg 版は reveal x pulse の組み合わせを全通り PNG 化して並べていたので出現が
 * 段階的だったが、ここは連続補間なので滑らかに出て脈動する。
 */
const APPEAR_F = 12;     // 1マーカーの出現にかけるフレーム
const STAGGER_F = 9;     // マーカー間の間隔
const PULSE_F = 40;      // 脈動1周期

export const MapScene: React.FC<{
  bg: string;
  markers: SMapMarker[];
  accent: string;
  appear: boolean;
}> = ({ bg, markers, accent, appear }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill>
      <Img src={staticFile(bg)} style={{ width: W, height: H, objectFit: "cover" }} />
      <AbsoluteFill>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
          {markers.map((m, i) => {
            const start = appear ? i * STAGGER_F : 0;
            const t = interpolate(frame, [start, start + APPEAR_F], [0, 1], {
              easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
            });
            if (t <= 0) return null;
            const color = m.strike ? "#FF5A4E" : accent;

            // 最後に出たマーカーだけ脈動させる (ffmpeg 版と同じ約束)
            const isLatest = i === markers.length - 1;
            const phase = ((frame - start) % PULSE_F) / PULSE_F;
            const ringR = isLatest ? 26 + phase * 34 : 34;
            const ringOp = (isLatest ? 0.85 - phase * 0.6 : 0.18) * t;

            return (
              <g key={i}>
                <circle cx={m.x} cy={m.y} r={ringR} fill="none" stroke={color} strokeWidth={5} opacity={ringOp} />
                <circle cx={m.x} cy={m.y} r={13 * t} fill={color} />
                <circle cx={m.x} cy={m.y} r={5 * t} fill="#0F1B3D" />
                {m.label && m.labelX !== undefined && m.labelY !== undefined && (
                  <text
                    x={m.labelX} y={m.labelY}
                    fontFamily={FONT} fontWeight={900} fontSize={34}
                    fill="#FFFFFF" stroke="#0F1B3D" strokeWidth={6}
                    paintOrder="stroke"
                    opacity={t}
                  >
                    {m.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
