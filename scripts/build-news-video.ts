import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 1 ストーリー単独 60秒動画を構築する。
 *
 * 入力:
 *   output/YYYY-MM-DD/script-en.json
 *   output/YYYY-MM-DD/voice-{code}.mp3   (~45-50s)
 *   output/YYYY-MM-DD/voice-{code}.vtt
 *   output/YYYY-MM-DD/_assets/bg-{code}-1..4.jpg  (背景画像 4枚)
 *   output/YYYY-MM-DD/_assets/{code}.png          (国旗)
 *
 * 出力:
 *   output/YYYY-MM-DD/news-{index}-{code}.mp4  (60s)
 *
 * 構成 (voice 約 45s + outro hold 約 15s):
 *   Hook         (0 → "comes from" cue 終了)        ~5s
 *   Body image 1 ("comes from" 終了 → 1/3 of body)  bg-{code}-1
 *   Body image 2 (1/3 → 2/3 of body)                bg-{code}-2
 *   Body image 3 (2/3 → "word of the day" cue 開始) bg-{code}-3
 *   Word card    ("word of the day" → "subscribe" cue 開始)
 *   Subscribe    ("subscribe" cue 開始 → 60s)
 */

const W = 1080;
const H = 1920;
const FPS = 30;
const TOTAL_DURATION = 60;

interface Country { code: string; flag: string; name?: string; }
interface Story { index: number; country: Country; headline: string; summary: string; sourceName: string; }
interface ScriptJson {
  date: string;
  stories: Story[];
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
}

interface VttCue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  for (const story of script.stories) {
    await buildOne(dir, story, script);
  }
}

async function buildOne(dir: string, story: Story, script: ScriptJson) {
  const code = story.country.code.toLowerCase();
  const audio = path.join(dir, `voice-${code}.mp3`);
  const vtt = path.join(dir, `voice-${code}.vtt`);
  const out = path.join(dir, `news-${story.index}-${code}.mp4`);

  const cues = await parseVtt(vtt);
  const audioDuration = await ffprobeDuration(audio);

  // Find key cue start times
  const find = (re: RegExp) => cues.find(c => re.test(c.text))?.start;
  const tHookEnd     = find(/comes from/i) ?? 4;                  // intro 終了 (≈4s)
  const tHeadline    = cues.find(c => c.text.includes(story.headline.slice(0, 20)))?.start ?? tHookEnd;
  const tWordStart   = find(/word of the day|english word/i) ?? Math.max(audioDuration - 10, 30);
  const tSubscribeStart = find(/subscribe/i) ?? Math.min(tWordStart + 12, audioDuration - 5);

  // Video总长: 60s。voice が短くても subscribe で hold。
  const targetTotal = TOTAL_DURATION;

  // 計画した scene timing (cue ベース)
  const hookStart = 0;
  const bodyStart = tHeadline;          // ヘッドライン読み上げ開始
  const bodyEnd = tWordStart;            // 「today's English word」 開始
  const wordEnd = tSubscribeStart;       // 「subscribe」 開始
  const subscribeEnd = targetTotal;      // 60s

  const bodyDur = bodyEnd - bodyStart;
  const t1 = bodyStart + bodyDur / 3;
  const t2 = bodyStart + 2 * bodyDur / 3;

  const scenes = [
    { id: "01-hook",     dur: bodyStart - hookStart, svg: hookSvg(story) },
    { id: "02-body1",    dur: t1 - bodyStart,        svg: bodySvg(story, "1", 1) },
    { id: "03-body2",    dur: t2 - t1,               svg: bodySvg(story, "2", 2) },
    { id: "04-body3",    dur: bodyEnd - t2,          svg: bodySvg(story, "3", 3) },
    { id: "05-word",     dur: wordEnd - bodyEnd,     svg: wordSvg(script.todaysWord) },
    { id: "06-subscribe",dur: subscribeEnd - wordEnd,svg: subscribeSvg() },
  ];

  console.log(`[news] ${code} (story ${story.index}): audio=${audioDuration.toFixed(1)}s, total=${targetTotal}s`);
  scenes.forEach(s => console.log(`[news]   ${s.id}: ${s.dur.toFixed(1)}s`));

  // 各シーンを PNG → MP4 (no zoompan)
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

  // Concat 全シーン
  const listFile = path.join(dir, `_concat-${code}.txt`);
  await fs.writeFile(listFile, segments.map(s => `file '${path.resolve(s)}'`).join("\n"), "utf-8");
  const bgVideo = path.join(dir, `_bg-${code}.mp4`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", bgVideo]);
  await fs.unlink(listFile).catch(() => {});

  // 音声重ね + 60s 切り
  await run("ffmpeg", [
    "-y",
    "-i", bgVideo,
    "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-t", String(targetTotal),
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    out,
  ]);

  // 中間ファイル削除
  for (const s of segments) await fs.unlink(s).catch(() => {});
  await fs.unlink(bgVideo).catch(() => {});
  for (const sc of scenes) {
    await fs.unlink(path.join(dir, `_n${story.index}-${sc.id}.png`)).catch(() => {});
  }

  const stat = await fs.stat(out);
  console.log(`[news] → ${out} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

// ─────── SVG scene builders ───────

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** Hook scene: dark bg + 国旗 + 国名 (full) + "TODAY'S NEWS" + Headline 大字 */
function hookSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  const headlineLines = wrap(story.headline, 22, 4);
  let headlineSvg = "";
  const startY = 1300;
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${startY + i * 100}" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>
  <!-- Top accent yellow stripe -->
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="60" y="200" font-family="Hiragino Sans" font-weight="900"
        font-size="60" fill="#F5E63B" letter-spacing="8">TODAY'S NEWS</text>
  <!-- Flag -->
  <image href="_assets/${code}.png" x="60" y="280" width="480" height="320"
         preserveAspectRatio="xMidYMid meet"/>
  <!-- Country name (large) -->
  <text x="60" y="780" font-family="Hiragino Sans" font-weight="900"
        font-size="110" fill="#FFFFFF" letter-spacing="-2">${escape(countryName.toUpperCase())}</text>
  <rect x="60" y="820" width="280" height="10" fill="#F5E63B"/>
  <!-- Source -->
  <text x="60" y="950" font-family="Hiragino Sans" font-weight="600"
        font-size="40" fill="#F5E63B" letter-spacing="6">${escape(story.sourceName.toUpperCase())}</text>
  <!-- "HEADLINE" label -->
  <text x="60" y="1180" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  ${headlineSvg}
  <!-- Brand footer -->
  <text x="60" y="1820" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1870" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A7A7A" letter-spacing="2">@60dailyworld</text>
</svg>`;
}

/** Body scene: full bleed bg image + dark overlay + headline 上部 + caption 下部 */
function bodySvg(story: Story, _label: string, bgN: 1 | 2 | 3): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  const headlineLines = wrap(story.headline, 24, 2);
  const summaryLines = wrap(story.summary, 28, 4);
  let headlineSvg = "";
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${260 + i * 80}" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  let summarySvg = "";
  summaryLines.forEach((line, i) => {
    summarySvg += `\n  <text x="60" y="${1400 + i * 70}" font-family="Hiragino Sans" font-weight="700"
        font-size="50" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="darken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0A0A0A" stop-opacity="0.92"/>
      <stop offset="20%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="80%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <!-- Full-bleed bg image -->
  <image href="_assets/bg-${code}-${bgN}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top: country chip + headline -->
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="60" y="160" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#F5E63B" letter-spacing="6">${escape(countryName.toUpperCase())}</text>
  ${headlineSvg}

  <!-- Country flag small -->
  <image href="_assets/${code}.png" x="820" y="100" width="200" height="135"
         preserveAspectRatio="xMidYMid meet"/>

  <!-- Bottom: summary -->
  <rect x="0" y="1340" width="${W}" height="6" fill="#F5E63B"/>
  ${summarySvg}

  <!-- Source -->
  <text x="60" y="1820" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#F5E63B" letter-spacing="4">SOURCE: ${escape(story.sourceName.toUpperCase())}</text>
</svg>`;
}

/** Today's word card */
function wordSvg(w: { word: string; definitionEn: string }): string {
  const defLines = wrap(w.definitionEn, 28, 3);
  let defSvg = "";
  const defStartY = 1180;
  defLines.forEach((line, i) => {
    defSvg += `\n  <text x="540" y="${defStartY + i * 70}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="700"
        font-size="52" fill="#FFFFFF" letter-spacing="0">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>
  <!-- Big label -->
  <rect x="60" y="160" width="960" height="80" fill="#F5E63B"/>
  <text x="540" y="220" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#0A0A0A" letter-spacing="8">TODAY'S ENGLISH WORD</text>
  <!-- Word -->
  <text x="540" y="800" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="220" fill="#F5E63B" letter-spacing="-4">${escape(w.word)}</text>
  <!-- Decoration line -->
  <rect x="240" y="900" width="600" height="8" fill="#F5E63B"/>
  <!-- Definition -->
  <text x="540" y="1060" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="40" fill="#9CA3AF" letter-spacing="6">MEANS</text>
  ${defSvg}
  <!-- Brand footer -->
  <text x="540" y="1820" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#7A8AB5" letter-spacing="3">DAILY WORLD 60 · @60dailyworld</text>
</svg>`;
}

/** Subscribe outro (held to end of video) */
function subscribeSvg(): string {
  const thumbUp = `<g transform="translate(396, 880) scale(2.4)">
    <path d="M0 60 L0 200 L100 200 L150 140 L150 90 L100 90 L120 30 Q120 0 90 0 L70 0 L40 60 Z"
          fill="#F5E63B" stroke="#0A0A0A" stroke-width="6" stroke-linejoin="round"/>
    <rect x="-40" y="60" width="40" height="140" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
  </g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Hero CTA -->
  <text x="540" y="500" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#FFFFFF" letter-spacing="2">PLEASE</text>
  <text x="540" y="640" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#F5E63B" letter-spacing="2">SUBSCRIBE</text>

  <!-- 👍 -->
  ${thumbUp}

  <!-- Channel block -->
  <rect x="60" y="1380" width="960" height="360" fill="#0A0A0A"/>
  <text x="540" y="1500" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="76" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="540" y="1590" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="50" fill="#FFFFFF" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1660" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#7A8AB5" letter-spacing="3">YouTube · TikTok · Instagram</text>
  <text x="540" y="1720" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A8AB5" letter-spacing="3">3 world news every day, in 60 seconds</text>
</svg>`;
}

// ─────── Helpers ───────

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
