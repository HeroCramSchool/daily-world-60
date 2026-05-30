import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 1 ストーリー単独 60秒動画を構築する (v7: 字幕同期 + 国旗なし body)。
 *
 * シーン構成:
 *   Hook       : 0 → "comes from" cue 終了 (≈4s)
 *                  → 国旗 + 国名 + headline 大字 + "TODAY'S NEWS"
 *   Captions   : headline cue → keyword cue 開始
 *                  → 各 cue を 1 scene 化、cue text を下部字幕として表示
 *                  → 背景画像 4 枚を cue index で cycle
 *                  → 上部に headline (compact) を常時 (国旗なし)
 *   Word card  : keyword cue → subscribe cue 開始
 *                  → 単語大字 + 定義中央寄せ
 *   Subscribe  : subscribe cue → 60s
 *                  → PLEASE SUBSCRIBE + 👍 + チャンネル名
 *
 * 入力:
 *   output/YYYY-MM-DD/script-en.json
 *   output/YYYY-MM-DD/voice-{code}.mp3, voice-{code}.vtt
 *   output/YYYY-MM-DD/_assets/bg-{code}-1..4.jpg, {code}.png
 */

const W = 1080;
const H = 1920;
const FPS = 30;
const TOTAL_DURATION = 60;

interface Country { code: string; flag: string; name?: string; }
interface Keyword { word: string; definitionEn: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  keyword?: Keyword;
}
interface ScriptJson {
  date: string;
  stories: Story[];
}

interface VttCue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  for (const story of script.stories) {
    await buildOne(dir, story);
  }
}

async function buildOne(dir: string, story: Story) {
  const code = story.country.code.toLowerCase();
  const audio = path.join(dir, `voice-${code}.mp3`);
  const vtt = path.join(dir, `voice-${code}.vtt`);
  const out = path.join(dir, `news-${story.index}-${code}.mp4`);

  const cues = await parseVtt(vtt);
  const audioDuration = await ffprobeDuration(audio);

  // Key cue indices
  const countryCueIdx = cues.findIndex(c => /comes from|news from/i.test(c.text));
  const wordCueIdx = cues.findIndex(c => /english keyword|english word|keyword from today's news|word of the day/i.test(c.text));
  const subscribeCueIdx = cues.findIndex(c => /subscribe/i.test(c.text));

  const tHookEnd = countryCueIdx >= 0 ? cues[countryCueIdx].end : 4;
  const tWordStart = wordCueIdx >= 0 ? cues[wordCueIdx].start : Math.max(audioDuration - 12, 30);
  const tSubscribeStart = subscribeCueIdx >= 0 ? cues[subscribeCueIdx].start : Math.min(tWordStart + 10, audioDuration - 4);

  // ─── Caption scenes (body) ───
  // 各 cue (after country, before word) を 1 scene にする
  const bodyStartIdx = countryCueIdx + 1;
  const bodyEndIdx = wordCueIdx;
  const bodyCues = cues.slice(bodyStartIdx, bodyEndIdx);

  // ─── Word scenes ───
  const wordCues = wordCueIdx >= 0 && subscribeCueIdx >= 0
    ? cues.slice(wordCueIdx, subscribeCueIdx)
    : [];

  // ─── Scene list ───
  type Scene = { id: string; dur: number; svg: string };
  const scenes: Scene[] = [];

  // Hook
  scenes.push({
    id: "01-hook",
    dur: tHookEnd,
    svg: hookSvg(story),
  });

  // Body cues: 各 cue を 1 scene 化
  bodyCues.forEach((cue, i) => {
    const dur = cue.end - cue.start;
    const bgN = ((i) % 4) + 1; // 1..4 cycle
    scenes.push({
      id: `02-cap${(i + 1).toString().padStart(2, "0")}`,
      dur,
      svg: captionSvg(story, cue.text, bgN as 1 | 2 | 3 | 4),
    });
  });

  // Word card: 各 word cue を 1 scene 化 (大字表示)
  wordCues.forEach((cue, i) => {
    const dur = cue.end - cue.start;
    scenes.push({
      id: `03-word${(i + 1).toString().padStart(2, "0")}`,
      dur,
      svg: wordSvg(story.keyword, cue.text, i, story),
    });
  });

  // Subscribe: 残り全部
  const usedSoFar = scenes.reduce((acc, s) => acc + s.dur, 0);
  const subscribeDur = Math.max(2, TOTAL_DURATION - usedSoFar);
  scenes.push({
    id: "04-subscribe",
    dur: subscribeDur,
    svg: subscribeSvg(story),
  });

  console.log(`[news] ${code} (story ${story.index}): audio=${audioDuration.toFixed(1)}s, total=${TOTAL_DURATION}s, scenes=${scenes.length}`);
  console.log(`[news]   hook end=${tHookEnd.toFixed(2)} word start=${tWordStart.toFixed(2)} subscribe=${tSubscribeStart.toFixed(2)}`);

  // ─── Render scenes ───
  const segments: string[] = [];
  for (const sc of scenes) {
    const svgPath = path.join(dir, `_n${story.index}-${sc.id}.svg`);
    const pngPath = path.join(dir, `_n${story.index}-${sc.id}.png`);
    const mp4Path = path.join(dir, `_n${story.index}-${sc.id}.mp4`);
    await fs.writeFile(svgPath, sc.svg, "utf-8");
    await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
    await fs.unlink(svgPath).catch(() => {});
    await run("ffmpeg", [
      "-y", "-loop", "1", "-i", pngPath,
      "-t", Math.max(0.1, sc.dur).toFixed(3),
      "-vf", `scale=${W}:${H},format=yuv420p`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
      mp4Path,
    ]);
    segments.push(mp4Path);
  }

  // Concat + audio
  const listFile = path.join(dir, `_concat-${code}.txt`);
  await fs.writeFile(listFile, segments.map(s => `file '${path.resolve(s)}'`).join("\n"), "utf-8");
  const bgVideo = path.join(dir, `_bg-${code}.mp4`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", bgVideo]);
  await fs.unlink(listFile).catch(() => {});

  await run("ffmpeg", [
    "-y",
    "-i", bgVideo,
    "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-t", String(TOTAL_DURATION),
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    out,
  ]);

  // Cleanup
  for (const s of segments) await fs.unlink(s).catch(() => {});
  await fs.unlink(bgVideo).catch(() => {});
  for (const sc of scenes) {
    await fs.unlink(path.join(dir, `_n${story.index}-${sc.id}.png`)).catch(() => {});
  }

  const stat = await fs.stat(out);
  console.log(`[news] → ${out} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

// ─────────── SVG scene builders ───────────

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Compact source URL: domain + first 40 chars of path. */
function shortUrl(url: string, maxLen = 56): string {
  const trimmed = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

/**
 * Single word (キーワード) を指定幅に収めるフォントサイズを返す。
 * Hiragino Sans 太字 letter-spacing -4 想定。文字幅は font-size の約 0.58 倍。
 */
function fitKeywordFontSize(word: string, maxWidth = 900, ceilingFontSize = 220): number {
  const widthPerChar = 0.58;
  const ideal = Math.floor(maxWidth / Math.max(1, word.length) / widthPerChar);
  return Math.min(ceilingFontSize, ideal);
}

/**
 * 与えられた文字列を box (W×H) に「一字一句残して」収めるフォントサイズと折り返し行を返す。
 * 大きい font から小さい font に降りていき、最初に box 内に収まるものを採用。
 */
function fitCaption(
  text: string,
  boxW: number,
  boxH: number,
  candidates = [64, 58, 52, 48, 44, 40, 36, 32, 28],
): { fontSize: number; lines: string[]; lineHeight: number } {
  const widthPerChar = 0.62; // Hiragino Sans 太字 letter-spacing -1 想定、安全マージン込み
  const lineGapRatio = 1.32;
  for (const fs of candidates) {
    const charsPerLine = Math.max(8, Math.floor(boxW / (fs * widthPerChar)));
    const lines = wrapAll(text, charsPerLine);
    const lineHeight = Math.round(fs * lineGapRatio);
    if (lines.length * lineHeight <= boxH) {
      return { fontSize: fs, lines, lineHeight };
    }
  }
  const fs = candidates[candidates.length - 1];
  const charsPerLine = Math.max(8, Math.floor(boxW / (fs * widthPerChar)));
  const lines = wrapAll(text, charsPerLine);
  return { fontSize: fs, lines, lineHeight: Math.round(fs * lineGapRatio) };
}

/** 折り返し: 行数の上限なし、一字一句残す。単語長が charsPerLine を超える場合は強制改行。 */
function wrapAll(text: string, charsPerLine: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let cur = "";
  for (const w of words) {
    if (w.length > charsPerLine) {
      if (cur) { lines.push(cur); cur = ""; }
      for (let i = 0; i < w.length; i += charsPerLine) {
        lines.push(w.slice(i, i + charsPerLine));
      }
      continue;
    }
    if ((cur + " " + w).trim().length > charsPerLine) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Source attribution footer (Y 1820-1910). Shown on hook + caption + word scenes.
 * Designed not to overlap with any other text element.
 */
function sourceFooter(story: Story): string {
  return `
  <!-- Source attribution footer -->
  <rect x="0" y="1820" width="${W}" height="100" fill="#0A0A0A" fill-opacity="0.92"/>
  <rect x="0" y="1820" width="${W}" height="3" fill="#F5E63B"/>
  <text x="60" y="1862" font-family="Hiragino Sans" font-weight="900"
        font-size="24" fill="#F5E63B" letter-spacing="4">SOURCE</text>
  <text x="60" y="1900" font-family="Hiragino Sans" font-weight="600"
        font-size="22" fill="#FFFFFF" letter-spacing="0">${escape(story.sourceName)} · ${escape(shortUrl(story.sourceUrl))}</text>`;
}
function wrap(text: string, maxChars: number, maxLines = 5): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur.trim());
  return lines.slice(0, maxLines);
}

/** Hook: 国旗 + 国名 + headline (only here flag shows large). */
function hookSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  // 国名 font: 単語長で動的に
  const cnFontSize = fitKeywordFontSize(countryName, 900, 130);
  // Headline: x=60, w=960、Y 1230-1790 (560px) に fit (max 56pt)
  const hlBoxW = 960, hlBoxH = 560, hlBoxY = 1230;
  const hlFit = fitCaption(story.headline, hlBoxW, hlBoxH,
                           [56, 50, 46, 42, 38, 34, 30, 26]);
  const hlTotalH = hlFit.lines.length * hlFit.lineHeight;
  const hlStartY = hlBoxY + (hlBoxH - hlTotalH) / 2 + hlFit.fontSize;
  let headlineSvg = "";
  hlFit.lines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${hlStartY + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="60" y="200" font-family="Hiragino Sans" font-weight="900"
        font-size="60" fill="#F5E63B" letter-spacing="8">TODAY'S NEWS</text>
  <image href="_assets/${code}.png" x="60" y="280" width="480" height="320"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="60" y="780" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFontSize}" fill="#FFFFFF" letter-spacing="-2">${escape(countryName.toUpperCase())}</text>
  <rect x="60" y="820" width="280" height="10" fill="#F5E63B"/>
  <text x="60" y="950" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#F5E63B" letter-spacing="6">DAILY WORLD 60</text>
  <text x="60" y="1000" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#9CA3AF" letter-spacing="3">@60dailyworld</text>
  <text x="60" y="1180" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  ${headlineSvg}
  ${sourceFooter(story)}
</svg>`;
}

/**
 * Caption scene (body):
 *   - bg image (full-bleed) with darken gradient
 *   - top: country chip + headline (compact, 国旗なし)
 *   - bottom: caption text (current cue text)
 */
function captionSvg(story: Story, captionText: string, bgN: 1 | 2 | 3 | 4): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  // Top headline area: Y 200-460 (260px height、上にコンパクトに) x=60 w=960
  const hlBoxW = 960, hlBoxH = 260, hlBoxY = 200;
  const hlFit = fitCaption(story.headline, hlBoxW, hlBoxH,
                           [52, 46, 42, 38, 34, 30, 28]);
  const hlStartY = hlBoxY + hlFit.fontSize + 8;
  let headlineSvg = "";
  hlFit.lines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${hlStartY + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  // Caption text: large, bottom-half, white with strong outline-feel via box bg
  // Caption box: Y 1260-1780 (1000x520)。一字一句残し、収まる font-size を動的決定。
  const boxX = 40, boxY = 1260, boxW = 1000, boxH = 520;
  const fit = fitCaption(captionText, boxW - 80, boxH - 80);
  const totalH = fit.lines.length * fit.lineHeight;
  const capStartY = boxY + (boxH - totalH) / 2 + fit.fontSize;
  let capSvg = "";
  fit.lines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${capStartY + i * fit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="darken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0A0A0A" stop-opacity="0.92"/>
      <stop offset="22%" stop-color="#0A0A0A" stop-opacity="0.50"/>
      <stop offset="68%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <image href="_assets/bg-${code}-${bgN}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top: yellow stripe + country (no flag) -->
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="60" y="160" font-family="Hiragino Sans" font-weight="900"
        font-size="40" fill="#F5E63B" letter-spacing="6">${escape(countryName.toUpperCase())}</text>
  ${headlineSvg}

  <!-- Bottom caption box (Y 1260-1780) -->
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#0A0A0A" fill-opacity="0.82" rx="20"/>
  ${capSvg}

  ${sourceFooter(story)}
</svg>`;
}

/**
 * Word card scene. cue text changes between "Today's English word from this story is X"
 *   / "X means: ..." / "You will hear this word in world news...".
 * We show the big word always and add the cue text below.
 */
function wordSvg(keyword: Keyword | undefined, cueText: string, cueIdx: number, story: Story): string {
  const word = keyword?.word ?? "word";
  // Keyword 大字は単語長で動的サイズ
  const kwFontSize = fitKeywordFontSize(word, 900, 220);

  // Caption box (Y 1140-1740) に一字一句収まる font-size を計算
  const boxX = 40, boxY = 1140, boxW = 1000, boxH = 600;
  const fit = fitCaption(cueText, boxW - 80, boxH - 80,
                         [56, 50, 46, 42, 38, 34, 30, 28]);
  const totalH = fit.lines.length * fit.lineHeight;
  const capStartY = boxY + (boxH - totalH) / 2 + fit.fontSize;
  let capSvg = "";
  fit.lines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${capStartY + i * fit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="700"
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Top label band -->
  <rect x="60" y="200" width="960" height="80" fill="#F5E63B"/>
  <text x="540" y="260" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="38" fill="#0A0A0A" letter-spacing="6">TODAY'S ENGLISH KEYWORD</text>

  <!-- Big keyword (dynamic font-size to avoid overflow) -->
  <text x="540" y="640" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${kwFontSize}" fill="#F5E63B" letter-spacing="-2">${escape(word)}</text>

  <!-- Divider -->
  <rect x="290" y="740" width="500" height="8" fill="#F5E63B"/>

  <!-- Section tag -->
  <text x="540" y="870" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#9CA3AF" letter-spacing="8">${cueIdx === 0 ? "LISTEN" : cueIdx === 1 ? "MEANING" : "USE IT"}</text>

  <!-- Caption box (Y 1140-1740) -->
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#0A0A0A" fill-opacity="0.45" rx="20"/>
  ${capSvg}

  <!-- Brand footer just above source footer -->
  <text x="540" y="1780" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#7A8AB5" letter-spacing="3">DAILY WORLD 60 · @60dailyworld</text>

  ${sourceFooter(story)}
</svg>`;
}

/** Subscribe outro. Source 行は最下部に表示。 */
function subscribeSvg(story: Story): string {
  const thumbUp = `<g transform="translate(396, 800) scale(2.4)">
    <path d="M0 60 L0 200 L100 200 L150 140 L150 90 L100 90 L120 30 Q120 0 90 0 L70 0 L40 60 Z"
          fill="#F5E63B" stroke="#0A0A0A" stroke-width="6" stroke-linejoin="round"/>
    <rect x="-40" y="60" width="40" height="140" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
  </g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>
  <text x="540" y="440" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#FFFFFF" letter-spacing="2">PLEASE</text>
  <text x="540" y="580" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#F5E63B" letter-spacing="2">SUBSCRIBE</text>
  ${thumbUp}
  <!-- Channel block (Y 1240-1500) -->
  <rect x="60" y="1240" width="960" height="260" fill="#0A0A0A"/>
  <text x="540" y="1330" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="540" y="1400" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#FFFFFF" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1455" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#7A8AB5" letter-spacing="3">YouTube · TikTok · Instagram</text>

  <!-- Disclaimer (Y 1540-1810, small grey) -->
  <text x="540" y="1565" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="20" fill="#9CA3AF" letter-spacing="4">DISCLAIMER</text>
  <text x="540" y="1610" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="20" fill="#9CA3AF" letter-spacing="0">News summaries are for general information only.</text>
  <text x="540" y="1640" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="20" fill="#9CA3AF" letter-spacing="0">Original reporting belongs to the publishers listed below.</text>
  <text x="540" y="1670" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="20" fill="#9CA3AF" letter-spacing="0">Please verify details with the original source.</text>
  <text x="540" y="1700" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="20" fill="#9CA3AF" letter-spacing="0">AI-assisted voice and video editing.</text>
  <text x="540" y="1730" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="20" fill="#9CA3AF" letter-spacing="0">Not affiliated with any government or publisher.</text>
  <text x="540" y="1770" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="18" fill="#6B7280" letter-spacing="2">© 2026 Daily World 60 · Fair use of news summaries (US §107 / JP 著作権法32条)</text>

  ${sourceFooter(story)}
</svg>`;
}

// ─────────── Helpers ───────────

async function parseVtt(p: string): Promise<VttCue[]> {
  const text = await fs.readFile(p, "utf-8");
  const cues: VttCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (m) {
      const start = toSec(m[1], m[2], m[3], m[4]);
      const end = toSec(m[5], m[6], m[7], m[8]);
      let txt = "";
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) txt += lines[j] + " ";
      cues.push({ start, end, text: txt.trim() });
    }
  }
  return cues;
}
function toSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}
function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    proc.stdout.on("data", chunk => (out += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n) || n <= 0) return reject(new Error(`bad duration: ${out}`));
      resolve(n);
    });
  });
}
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
