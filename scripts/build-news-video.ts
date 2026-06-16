import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fitSingleLine, fitTextBox, textWidthEm, clampAttr } from "./lib/textfit.js";

/**
 * 1 ストーリー単独動画を構築する (v8: 尺=音声長に動的化, 字幕同期 + 国旗なし body)。
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
 *   Subscribe  : outro cue ("thanks for watching") → 音声末尾 (≈5s)
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

interface Country { code: string; flag: string; name?: string; }
interface Keyword { word: string; definitionEn: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  keyword?: Keyword;
  /** 3-6語の画面用フック (数字入り推奨)。無ければ headline で代用。 */
  hookText?: string;
  hookPattern?: string;
}
interface ScriptJson {
  date: string;
  stories: Story[];
}

interface VttCue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
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
  // 動画尺は音声長に合わせる (60秒固定をやめる)。本文が長い回でも末尾が切れない。
  const total = audioDuration + 0.4;

  // Key cue indices (新ナレーション: cold open → "Here's what's happening." → summary
  //   → "Quick English check..." → "And that's the latest from X.")
  // 旧ナレーションの表現もフォールバックで検出する。
  const countryCueIdx = cues.findIndex(c => /here's what's happening|comes from|news from/i.test(c.text));
  const wordCueIdx = cues.findIndex(c => /quick english check|english keyword|english word|keyword from today's news|word of the day/i.test(c.text));
  const outroCueIdx = cues.findIndex(c => /that's the latest|thanks for watching|subscribe/i.test(c.text));

  const tHookEnd = countryCueIdx >= 0 ? cues[countryCueIdx].end : 4;

  // ─── Caption scenes (body) ───
  const bodyStartIdx = countryCueIdx + 1;
  const bodyEndIdx = wordCueIdx >= 0 ? wordCueIdx
    : outroCueIdx >= 0 ? outroCueIdx
    : cues.length;
  const bodyCues = cues.slice(bodyStartIdx, bodyEndIdx);

  // ─── Word scenes ───
  const wordCues = wordCueIdx >= 0
    ? cues.slice(wordCueIdx, outroCueIdx >= 0 ? outroCueIdx : cues.length)
    : [];

  // ─── Outro cues: bg-1 (フックと同じ画像) に戻る = ループ接続。エンドカードは置かない ───
  const outroCues = outroCueIdx >= 0 ? cues.slice(outroCueIdx) : [];

  // ─── Scene list ───
  type Scene = { id: string; dur: number; svg: string };
  const scenes: Scene[] = [];

  // Hook
  scenes.push({
    id: "01-hook",
    dur: tHookEnd,
    svg: hookSvg(story),
  });

  // Body cues: 各 cue を 1 scene 化 (bg-2..6 cycle、caption 位置は交互に変化)
  bodyCues.forEach((cue, i) => {
    const dur = cue.end - cue.start;
    const bgN = (i % 5) + 2;
    scenes.push({
      id: `02-cap${(i + 1).toString().padStart(2, "0")}`,
      dur,
      svg: captionSvg(story, cue.text, bgN, i),
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

  // Outro: フックと同じ写真 (bg-1) の上に PLEASE SUBSCRIBE を重ねた1シーン。
  // outro 区間 (= "that's the latest" 以降) の合計尺をまるごと使う。
  if (outroCues.length) {
    const outroDur = outroCues.reduce((acc, c) => acc + (c.end - c.start), 0);
    scenes.push({ id: "04-subscribe", dur: Math.max(1.5, outroDur), svg: subscribeOutroSvg(story) });
  }

  // 端数 (audio + 0.4s pad) は最終シーンに吸収させる
  const usedSoFar = scenes.reduce((acc, s) => acc + s.dur, 0);
  const pad = total - usedSoFar;
  if (pad > 0.05 && scenes.length > 0) scenes[scenes.length - 1].dur += pad;

  console.log(`[news] ${code} (story ${story.index}): audio=${audioDuration.toFixed(1)}s, total=${total.toFixed(1)}s, scenes=${scenes.length} (body=${bodyCues.length}, word=${wordCues.length}, outro=${outroCues.length})`);
  console.log(`[news]   hook end=${tHookEnd.toFixed(2)} outro start=${outroCueIdx >= 0 ? cues[outroCueIdx].start.toFixed(2) : "n/a"}`);

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

  // BGM (news bed) をナレーションの下に低音量でミックス。
  // assets/news-bed.mp3 (または BGM_PATH) が無ければ BGM なしで従来どおり。
  const bgmFile = process.env.BGM_PATH ?? path.join("assets", "news-bed.mp3");
  const hasBgm = await fs.access(bgmFile).then(() => true).catch(() => false);
  const bgmVol = process.env.BGM_VOLUME ?? "0.10";

  const muxArgs = hasBgm
    ? [
        "-y",
        "-i", bgVideo,
        "-i", audio,
        "-stream_loop", "-1", "-i", bgmFile,
        "-filter_complex",
        `[1:a]volume=1.0[vo];[2:a]volume=${bgmVol}[bg];[vo][bg]amix=inputs=2:duration=first:normalize=0[mix]`,
        "-map", "0:v:0", "-map", "[mix]",
        "-t", total.toFixed(2),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-r", String(FPS),
        out,
      ]
    : [
        "-y",
        "-i", bgVideo,
        "-i", audio,
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", total.toFixed(2),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-r", String(FPS),
        out,
      ];
  if (hasBgm) console.log(`[news] ${code}: mixing BGM (${bgmFile}, vol ${bgmVol})`);
  await run("ffmpeg", muxArgs);

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
 * テキストフィットは lib/textfit.ts の実測幅エンジンに委譲する。
 * (一律係数による過小評価ではみ出した事故の再発防止。全テキスト要素で使用。)
 */
function fitKeywordFontSize(word: string, maxWidth = 900, ceilingFontSize = 220): number {
  return fitSingleLine(word.toUpperCase(), maxWidth, ceilingFontSize);
}

function fitCaption(
  text: string,
  boxW: number,
  boxH: number,
  candidates = [64, 58, 52, 48, 44, 40, 36, 32, 28, 24],
): { fontSize: number; lines: string[]; lineHeight: number } {
  return fitTextBox(text, boxW, boxH, candidates);
}

/**
 * Source attribution footer (Y 1820-1910). Shown on every scene.
 * 右側に AI 音声・file photo の常時開示 (inauthentic 対策)。
 * source 行は実測幅で 760px に収まるフォントサイズに自動縮小。
 */
function sourceFooter(story: Story): string {
  const srcLine = `${story.sourceName} · ${shortUrl(story.sourceUrl)}`;
  const srcFs = fitSingleLine(srcLine, 760, 22);
  return `
  <!-- Source attribution footer -->
  <rect x="0" y="1820" width="${W}" height="100" fill="#0A0A0A" fill-opacity="0.92"/>
  <rect x="0" y="1820" width="${W}" height="3" fill="#F5E63B"/>
  <text x="60" y="1862" font-family="Hiragino Sans" font-weight="900"
        font-size="24" fill="#F5E63B" letter-spacing="4">SOURCE</text>
  <text x="${W - 60}" y="1862" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="20" fill="#9CA3AF" letter-spacing="1">AI VOICE · FILE PHOTOS</text>
  <text x="60" y="1900" font-family="Hiragino Sans" font-weight="600"
        font-size="${srcFs}" fill="#FFFFFF" letter-spacing="0"${clampAttr(srcLine, srcFs, 760, 0)}>${escape(srcLine)}</text>`;
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

/**
 * Hook (1フレーム目=サムネイル設計):
 *   - 劇的写真をほぼ素のまま主役に (暗幕は下部のみ)
 *   - 特大フックテキスト (hookText 3-6語、無ければ headline)
 *   - 国旗+国名は左上の小チップに格下げ
 */
function hookSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  const cnText = countryName.toUpperCase();
  const cnFs = fitSingleLine(cnText, 560, 40);

  // 特大フック: hookText 優先 (大文字化)。fallback は headline (文そのまま)。
  const hookRaw = story.hookText?.trim() || story.headline;
  const isShortHook = Boolean(story.hookText?.trim());
  const hookShown = isShortHook ? hookRaw.toUpperCase() : hookRaw;
  const boxY = 980, boxH = 660;
  const hFit = fitTextBox(hookShown, 960, boxH,
    isShortHook ? [120, 110, 100, 92, 84, 76, 68, 60, 52] : [76, 68, 62, 56, 50, 46, 42, 38, 34]);
  const totalH = hFit.lines.length * hFit.lineHeight;
  const startY = boxY + (boxH - totalH) + hFit.fontSize - Math.round(hFit.fontSize * 0.2);
  let hookSvgText = "";
  hFit.lines.forEach((line, i) => {
    hookSvgText += `\n  <text x="60" y="${startY + i * hFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hFit.fontSize}" fill="#FFFFFF" letter-spacing="-1"${clampAttr(line, hFit.fontSize, 960, -1)}>${escape(line)}</text>`;
  });

  // 国名チップ: テキスト幅から算出、ただし右マージン 60px を超えないよう上限クランプ。
  const chipTextX = 208;
  const chipMaxTextW = W - 60 - chipTextX; // 国名テキストが使える最大幅 (= 812)
  const cnClamp = clampAttr(cnText, cnFs, chipMaxTextW, 1);
  // chip 背景は実フォント (推定より太い) を必ず内包するよう推定幅を 1.1x 膨らませる。
  const cnDrawW = Math.min(chipMaxTextW, Math.ceil((textWidthEm(cnText) * cnFs + (cnText.length - 1) * 1) * 1.1));
  const chipW = Math.min(W - 120, chipTextX - 60 + cnDrawW + 28);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="hookDarken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"  stop-color="#0A0A0A" stop-opacity="0.35"/>
      <stop offset="45%" stop-color="#0A0A0A" stop-opacity="0.12"/>
      <stop offset="62%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.94"/>
    </linearGradient>
  </defs>
  <!-- Dramatic photo is the hero -->
  <image href="_assets/bg-${code}-1.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#hookDarken)"/>

  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>

  <!-- Country chip: flag + name。右上ブランドは廃止 (長い国名との衝突防止)。
       テキストは chipMaxTextW を超えると自動圧縮 = 絶対にはみ出さない。 -->
  <rect x="60" y="110" width="${chipW}" height="96" rx="14" fill="#0A0A0A" fill-opacity="0.78"/>
  <image href="_assets/${code}.png" x="84" y="128" width="96" height="60"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="${chipTextX}" y="172" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="1"${cnClamp}>${escape(cnText)}</text>

  ${hookSvgText}
  ${sourceFooter(story)}
</svg>`;
}

/**
 * Caption scene (body):
 *   - bg image (full-bleed) with darken gradient
 *   - top: country chip + headline (compact, 国旗なし)
 *   - bottom: caption text (current cue text)
 */
function captionSvg(story: Story, captionText: string, bgN: number, sceneIdx = 0): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  const cnText = countryName.toUpperCase();
  // 国名行: letter-spacing 6 の分を概算で引いた幅に実測フィット + 絶対クランプ (x=60, 右マージン60 → 幅960)
  const cnFs = fitSingleLine(cnText, 960 - cnText.length * 6, 40);
  const cnClamp = clampAttr(cnText, cnFs, 960, 6);
  // Top headline area: Y 200-460 (260px height、上にコンパクトに) x=60 w=960
  const hlBoxW = 960, hlBoxH = 260, hlBoxY = 200;
  const hlFit = fitCaption(story.headline, hlBoxW, hlBoxH,
                           [52, 46, 42, 38, 34, 30, 28, 24]);
  const hlStartY = hlBoxY + hlFit.fontSize + 8;
  let headlineSvg = "";
  hlFit.lines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${hlStartY + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1"${clampAttr(line, hlFit.fontSize, hlBoxW, -1)}>${escape(line)}</text>`;
  });
  // 構成ローテ: シーンごとに caption box の位置とアクセントを交互に変える
  // (視覚変化を作りつつ、headline 帯 (~Y460) とフッター (Y1820) には絶対に重ねない)
  const variant = sceneIdx % 2;
  const boxX = 40, boxY = variant === 0 ? 1260 : 1180, boxW = 1000, boxH = 520;
  const fit = fitCaption(captionText, boxW - 80, boxH - 80);
  const totalH = fit.lines.length * fit.lineHeight;
  const capStartY = boxY + (boxH - totalH) / 2 + fit.fontSize;
  let capSvg = "";
  fit.lines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${capStartY + i * fit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0"${clampAttr(line, fit.fontSize, boxW - 80, 0)}>${escape(line)}</text>`;
  });
  const accent = variant === 1
    ? `<rect x="${boxX}" y="${boxY}" width="14" height="${boxH}" fill="#F5E63B" rx="7"/>`
    : "";
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
        font-size="${cnFs}" fill="#F5E63B" letter-spacing="6"${cnClamp}>${escape(cnText)}</text>
  ${headlineSvg}

  <!-- Caption box -->
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#0A0A0A" fill-opacity="0.82" rx="20"/>
  ${accent}
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
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0"${clampAttr(line, fit.fontSize, boxW - 80, 0)}>${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Top label band -->
  <rect x="60" y="200" width="960" height="80" fill="#F5E63B"/>
  <text x="540" y="260" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="38" fill="#0A0A0A" letter-spacing="6"${clampAttr("TODAY'S ENGLISH KEYWORD", 38, 900, 6)}>TODAY'S ENGLISH KEYWORD</text>

  <!-- Big keyword (dynamic font-size to avoid overflow) -->
  <text x="540" y="640" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${kwFontSize}" fill="#F5E63B" letter-spacing="-2"${clampAttr(word, kwFontSize, 960, -2)}>${escape(word)}</text>

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

/**
 * Subscribe outro: フックと同じ写真 (bg-1) の上に PLEASE SUBSCRIBE を重ねる。
 * 単色のデッドエンドカードは避けつつ、末尾に登録 CTA を明示 (ユーザー要望)。
 * 全テキストは実測フィットで枠内に収める。
 */
function subscribeOutroSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const plFs = fitSingleLine("PLEASE", 760, 110);
  const subFs = fitSingleLine("SUBSCRIBE", 1000, 156);
  const handle = "@60dailyworld";
  const hFs = fitSingleLine(handle, 760, 44);
  const yPlease = 760;
  const ySub = yPlease + Math.round(subFs * 1.02);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="subDarken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#0A0A0A" stop-opacity="0.78"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <image href="_assets/bg-${code}-1.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#subDarken)"/>
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>

  <text x="540" y="${yPlease}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${plFs}" fill="#FFFFFF" letter-spacing="4"${clampAttr("PLEASE", plFs, 1000, 4)}>PLEASE</text>
  <text x="540" y="${ySub}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${subFs}" fill="#F5E63B" letter-spacing="2"${clampAttr("SUBSCRIBE", subFs, 1000, 2)}>SUBSCRIBE</text>
  <rect x="340" y="${ySub + 50}" width="400" height="10" fill="#F5E63B"/>
  <text x="540" y="${ySub + 170}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${hFs}" fill="#FFFFFF" letter-spacing="3"${clampAttr(handle, hFs, 1000, 3)}>${escape(handle)}</text>
  <text x="540" y="${ySub + 240}" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="30" fill="#9CA3AF" letter-spacing="6">DAILY WORLD 60</text>

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
