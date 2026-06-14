/**
 * Measured-width text fitting for SVG scenes (shorts + longform).
 *
 * 一律係数 (0.58em/char 等) は "THE WORLD CUP" のようなワイド字で実幅を
 * 過小評価しフレーム外にはみ出す事故を起こした。ここでは文字ごとの幅テーブルで
 * 見積もる。テーブルは Hiragino Sans W9 / DejaVu Sans Bold (CI fallback) の
 * どちらでも溢れないよう「広め」に倒してある。狭く見積もるよりフォントが
 * 一段小さくなる方を常に選ぶ。
 */

function glyphEm(ch: string): number {
  if (/[MWQ@]/.test(ch)) return 0.98;
  if (/[ABCDGHKNOPRSUVXYZ]/.test(ch)) return 0.80;
  if (/[EFLTZ]/.test(ch)) return 0.68;
  if (/[IJ]/.test(ch)) return 0.44;
  if (/[mw]/.test(ch)) return 0.92;
  if (/[abcdeghknopqsuvxyz]/.test(ch)) return 0.62;
  if (/[ftr]/.test(ch)) return 0.46;
  if (/[ijl]/.test(ch)) return 0.32;
  if (/[0-9]/.test(ch)) return 0.66;
  if (ch === " ") return 0.34;
  if (/[.,:;'’`]/.test(ch)) return 0.32;
  if (/[-–—_]/.test(ch)) return 0.50;
  if (/[%$€£¥&#]/.test(ch)) return 0.82;
  if (/["“”()\[\]]/.test(ch)) return 0.42;
  if (/[!?]/.test(ch)) return 0.40;
  // CJK・絵文字・その他は全角相当で見積もる
  if (ch.charCodeAt(0) > 0x2e80) return 1.05;
  return 0.70;
}

/** テキスト全体の推定幅 (em単位、font-size 1px あたりの px)。 */
export function textWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphEm(ch);
  return w;
}

/** 1行テキストを maxWidth(px) に収めるフォントサイズ。 */
export function fitSingleLine(text: string, maxWidth: number, ceilingFontSize: number): number {
  const em = textWidthEm(text);
  const ideal = Math.floor(maxWidth / Math.max(0.5, em));
  return Math.min(ceilingFontSize, ideal);
}

/** 実測幅ベースの貪欲折り返し。1単語が maxEm を超える場合は文字単位で強制分割。 */
export function wrapByWidth(text: string, maxEm: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let cur = "";
  let curEm = 0;
  const SPACE = glyphEm(" ");
  for (const w of words) {
    const wEm = textWidthEm(w);
    if (wEm > maxEm) {
      // 超長単語 (URL等): 文字単位で割る
      if (cur) { lines.push(cur); cur = ""; curEm = 0; }
      let chunk = "";
      let chunkEm = 0;
      for (const ch of w) {
        const cEm = glyphEm(ch);
        if (chunkEm + cEm > maxEm && chunk) { lines.push(chunk); chunk = ""; chunkEm = 0; }
        chunk += ch; chunkEm += cEm;
      }
      if (chunk) { cur = chunk; curEm = chunkEm; }
      continue;
    }
    const addEm = cur ? SPACE + wEm : wEm;
    if (curEm + addEm > maxEm && cur) {
      lines.push(cur);
      cur = w; curEm = wEm;
    } else {
      cur = cur ? cur + " " + w : w;
      curEm += addEm;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 単行テキストの「絶対はみ出さない」保証用属性。
 * 推定自然幅 (letter-spacing 込み) が maxWidth を超えるときだけ
 * ` textLength="maxWidth" lengthAdjust="spacingAndGlyphs"` を返す。
 * 超えていなければ空文字 (短い文字を引き伸ばさない)。
 * フォント実測と無関係に、レンダラ側が必ず maxWidth 内に収める = 画面切れ/重なりゼロ。
 */
export function clampAttr(text: string, fontSize: number, maxWidth: number, letterSpacing = 0): string {
  const n = [...text].length;
  const natural = textWidthEm(text) * fontSize + Math.max(0, n - 1) * letterSpacing;
  if (natural <= maxWidth) return "";
  return ` textLength="${Math.floor(maxWidth)}" lengthAdjust="spacingAndGlyphs"`;
}

export interface FitResult { fontSize: number; lines: string[]; lineHeight: number; }

/**
 * テキストを box (W×H px) に一字一句残して収める。
 * 大きい候補フォントから降りていき、「全行の実測幅 ≤ boxW」かつ
 * 「行数×行高 ≤ boxH」を最初に満たすサイズを採用。
 * どの候補でも高さが収まらない場合は最小候補からさらに 2px 刻みで 16px まで縮める。
 */
export function fitTextBox(
  text: string,
  boxW: number,
  boxH: number,
  candidates: number[] = [64, 58, 52, 48, 44, 40, 36, 32, 28, 24],
  lineGapRatio = 1.32,
): FitResult {
  const tryFs = (fs: number): FitResult | null => {
    const lines = wrapByWidth(text, boxW / fs);
    const lineHeight = Math.round(fs * lineGapRatio);
    if (lines.length * lineHeight <= boxH) return { fontSize: fs, lines, lineHeight };
    return null;
  };
  for (const fs of candidates) {
    const r = tryFs(fs);
    if (r) return r;
  }
  for (let fs = Math.min(...candidates) - 2; fs >= 16; fs -= 2) {
    const r = tryFs(fs);
    if (r) return r;
  }
  const fs = 16;
  const lines = wrapByWidth(text, boxW / fs);
  return { fontSize: fs, lines, lineHeight: Math.round(fs * lineGapRatio) };
}
