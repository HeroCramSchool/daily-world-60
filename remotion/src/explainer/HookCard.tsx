import React from "react";
import { BigText } from "../short/Caption";
import { SAFE, CONTENT_W } from "./Stage";

// hero: 冒頭とループの戻りで出す大きな見出し (地図の帯 y 470 の上)。compact: 本文中の見出し。
// fitH は全行が収まる高さ、h は見せる箱の高さ。compact は 2 行までに抑えるため fitH を h より低くしている
const MODES = {
  hero: { top: 196, h: 274, fitH: 274, sizes: [128, 116, 104, 96, 88, 80, 72, 64, 56, 50] },
  compact: { top: 196, h: 210, fitH: 132, sizes: [64, 58, 52, 48, 44, 40, 36, 32] },
} as const;

// Inter 900 の実測の字幅 (em)。fit.ts の見積は W・M などを狭く数えるので、hero では最後の行が箱の外に隠れた
const ADV: Record<string, number> = {
  A: 0.795, B: 0.668, C: 0.748, D: 0.723, E: 0.613, F: 0.584, G: 0.754, H: 0.75, I: 0.291, J: 0.596, K: 0.759, L: 0.565, M: 0.956,
  N: 0.77, O: 0.775, P: 0.656, Q: 0.787, R: 0.668, S: 0.666, T: 0.687, U: 0.722, V: 0.795, W: 1.082, X: 0.786, Y: 0.775, Z: 0.694,
  0: 0.711, 1: 0.452, 2: 0.646, 3: 0.669, 4: 0.702, 5: 0.646, 6: 0.675, 7: 0.595, 8: 0.679, 9: 0.675,
  ",": 0.373, ".": 0.373, "%": 1.044, $: 0.666, "-": 0.475, "'": 0.372, "’": 0.353, ":": 0.373, ";": 0.378, "!": 0.381, "?": 0.601,
  "&": 0.695, "/": 0.412, "+": 0.693, "(": 0.388, ")": 0.388, "#": 0.662, "€": 0.7, "£": 0.662, "°": 0.463, "—": 1, "–": 0.5,
  '"': 0.625, "“": 0.625, "”": 0.61, "@": 1.059, "×": 0.693, Æ: 1.047, Œ: 1.029,
};
// アクセント付きの字は元の字と同じ幅。表に無い字は W より広く数える
const advOf = (ch: string) => ADV[ch] ?? ADV[ch.normalize("NFD")[0]] ?? 1.1;

/** 見出しを size で組んだ高さ (px)。BigText と同じ折り返し (幅 CONTENT_W・語の間 0.24em・字間 -1px・行 1.06) を実測の字幅で数える。 */
export function hookHeight(text: string, size: number): number {
  const gap = Math.round(size * 0.24);
  let lines = 0;
  let cur = -1;
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    const w = [...word].reduce((a, ch) => a + advOf(ch) * size - 1, 0) * 1.03;
    if (w > CONTENT_W) return Infinity;
    if (cur >= 0 && cur + gap + w <= CONTENT_W) cur += gap + w;
    else { lines++; cur = w; }
  }
  return lines * size * 1.06 + Math.max(0, lines - 1) * Math.round(size * 0.06);
}

export const hookFontSize = (text: string, mode: keyof typeof MODES): number => {
  const m = MODES[mode];
  return m.sizes.find(s => hookHeight(text, s) <= m.fitH) ?? m.sizes[m.sizes.length - 1];
};

/** 見出し。0 フレーム目から全文を出し、先頭の数字だけ accent 色にする。 */
export const HookCard: React.FC<{ text: string; accent: string; mode: keyof typeof MODES; opacity: number; fps: number }> = ({
  text, accent, mode, opacity, fps,
}) => {
  if (opacity <= 0) return null;
  const m = MODES[mode];
  return (
    <div style={{ position: "absolute", left: SAFE.left, top: m.top, width: CONTENT_W, height: m.h, overflow: "hidden", opacity }}>
      {/* サイズはここで決めて1つだけ渡す (fitSize は候補が1つならそれを返す) */}
      <BigText
        text={text.toUpperCase()}
        local={0}
        fps={fps}
        boxW={CONTENT_W}
        boxH={m.h}
        maxSize={[hookFontSize(text, mode)]}
        instant
        accentFirstToken
        accent={accent}
      />
    </div>
  );
};
