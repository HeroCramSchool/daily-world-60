import React from "react";
import { BigText } from "../short/Caption";
import { SAFE, CONTENT_W, FIT_W } from "./Stage";

// hero: 冒頭とループの戻りで出す大きな見出し (地図の帯 y 470 の上)。compact: 本文中の見出し。
// fitH は文字サイズを決める高さ、h は見せる箱の高さ。W の多い大文字は見積より1行増えることがあり、その1行ぶんを h に残す
const MODES = {
  hero: { top: 196, h: 274, fitH: 256, sizes: [128, 116, 104, 96, 88, 80, 72, 64, 56, 50] },
  compact: { top: 196, h: 210, fitH: 132, sizes: [64, 58, 52, 48, 44, 40, 36, 32] },
} as const;

/** 見出し。0 フレーム目から全文を出し、先頭の数字だけ accent 色にする。 */
export const HookCard: React.FC<{ text: string; accent: string; mode: keyof typeof MODES; opacity: number; fps: number }> = ({
  text, accent, mode, opacity, fps,
}) => {
  if (opacity <= 0) return null;
  const m = MODES[mode];
  return (
    <div style={{ position: "absolute", left: SAFE.left, top: m.top, width: CONTENT_W, height: m.h, overflow: "hidden", opacity }}>
      <BigText
        text={text.toUpperCase()}
        local={0}
        fps={fps}
        boxW={FIT_W}
        boxH={m.fitH}
        maxSize={[...m.sizes]}
        instant
        accentFirstToken
        accent={accent}
      />
    </div>
  );
};
