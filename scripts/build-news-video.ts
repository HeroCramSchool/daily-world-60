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
  const wordCueIdx = cues.findIndex(c => /english word from this story|word of the day/i.test(c.text));
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
  const headlineLines = wrap(story.headline, 22, 3);
  let headlineSvg = "";
  const startY = 1310;
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${startY + i * 100}" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
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
        font-size="110" fill="#FFFFFF" letter-spacing="-2">${escape(countryName.toUpperCase())}</text>
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
  const headlineLines = wrap(story.headline, 28, 2);
  let headlineSvg = "";
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${230 + i * 70}" font-family="Hiragino Sans" font-weight="900"
        font-size="54" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  // Caption text: large, bottom-half, white with strong outline-feel via box bg
  const capLines = wrap(captionText, 24, 3);
  // Caption box: Y 1280-1740 (avoid source footer Y 1820+ and avoid overlap with top headline)
  const capStartY = 1380;
  let capSvg = "";
  capLines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${capStartY + i * 90}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="68" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
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

  <!-- Bottom caption box (Y 1280-1780) -->
  <rect x="40" y="1280" width="1000" height="500" fill="#0A0A0A" fill-opacity="0.80" rx="20"/>
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
  const capLines = wrap(cueText, 26, 3);
  let capSvg = "";
  capLines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${1180 + i * 75}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="700"
        font-size="54" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>
  <rect x="60" y="160" width="960" height="80" fill="#F5E63B"/>
  <text x="540" y="220" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#0A0A0A" letter-spacing="8">TODAY'S ENGLISH WORD</text>
  <text x="540" y="780" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="210" fill="#F5E63B" letter-spacing="-4">${escape(word)}</text>
  <rect x="240" y="880" width="600" height="8" fill="#F5E63B"/>
  <text x="540" y="1050" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="40" fill="#9CA3AF" letter-spacing="6">${cueIdx === 0 ? "LISTEN" : cueIdx === 1 ? "MEANING" : "USE IT"}</text>
  <rect x="40" y="1110" width="1000" height="380" fill="#0A0A0A" fill-opacity="0.45" rx="20"/>
  ${capSvg}
  <text x="540" y="1780" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A8AB5" letter-spacing="3">DAILY WORLD 60 · @60dailyworld</text>
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
  <!-- Channel block (Y 1300-1620, smaller to leave room for source footer) -->
  <rect x="60" y="1300" width="960" height="320" fill="#0A0A0A"/>
  <text x="540" y="1410" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="68" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="540" y="1490" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#FFFFFF" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1550" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A8AB5" letter-spacing="3">YouTube · TikTok · Instagram</text>
  <text x="540" y="1600" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="24" fill="#7A8AB5" letter-spacing="3">3 world news every day, in 60 seconds</text>

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
