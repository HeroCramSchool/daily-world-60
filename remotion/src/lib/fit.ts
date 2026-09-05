/** DOM 計測を使わずに文字サイズを決める。Inter 900 の実測平均字幅から見積もる。
 *  build-news-video.ts の fitTextBox と同じ考え方 (候補サイズを大きい順に試す)。 */
const EM = (s: string) => {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w += 0.26;
    else if (/[iIl1.,:;'!|]/.test(ch)) w += 0.3;
    else if (/[A-Z0-9]/.test(ch)) w += 0.63;
    else if (/[mwMW]/.test(ch)) w += 0.86;
    else w += 0.55;
  }
  return w;
};

export function wrapText(text: string, maxWidthPx: number, fontSize: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (EM(next) * fontSize <= maxWidthPx) { cur = next; continue; }
    if (cur) lines.push(cur);
    if (EM(word) * fontSize > maxWidthPx) return null;
    cur = word;
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

export function fitLines(
  text: string, boxW: number, boxH: number, sizes: number[], lineHeightRatio = 1.16
): { fontSize: number; lines: string[]; lineHeight: number } {
  for (const fontSize of sizes) {
    const lh = Math.round(fontSize * lineHeightRatio);
    const lines = wrapText(text, boxW, fontSize, Math.max(1, Math.floor(boxH / lh)));
    if (lines) return { fontSize, lines, lineHeight: lh };
  }
  const last = sizes[sizes.length - 1];
  const lh = Math.round(last * lineHeightRatio);
  return { fontSize: last, lines: [text], lineHeight: lh };
}

/** 折り返し前提のブロックで、箱に収まる最大サイズだけ返す (行分けは flex-wrap に任せる)。 */
export function fitSize(text: string, boxW: number, boxH: number, sizes: number[], lineHeightRatio = 1.2): number {
  for (const fontSize of sizes) {
    const lh = fontSize * lineHeightRatio;
    const lines = wrapText(text, boxW, fontSize, Math.max(1, Math.floor(boxH / lh)));
    if (lines) return fontSize;
  }
  return sizes[sizes.length - 1];
}
