import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * v4: 音声同期 + 背景画像 + outro hold.
 *
 * シーン構成:
 *   Intro    : 0 → "Story 1 from..." 開始時刻
 *   Story 1  : Story 1 ナレ開始 → Story 2 ナレ開始
 *   Story 2  : Story 2 ナレ開始 → Story 3 ナレ開始
 *   Story 3  : Story 3 ナレ開始 → "Today's word..." 開始
 *   Outro    : Today's word 開始 → 音声終了
 *
 * 背景画像 (CC-BY-SA, Wikimedia):
 *   bg-cd.jpg (Kinshasa / Congo)
 *   bg-kw.jpg (Kuwait City)
 *   bg-sg.jpg (Marina Bay Sands)
 *   暗く curves 済み (0.5→0.28) で文字に邪魔にならない
 *
 * 国旗 PNG: flagcdn ベース (PD)
 *
 * 全文字列英語。
 */

const W = 1080;
const H = 1920;
const FPS = 30;

interface Story {
  index: number;
  country: { code: string; flag: string };
  headline: string;
  summary: string;
  sourceName: string;
}
interface Script {
  date: string;
  stories: Story[];
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
  close: string;
}

const CONTEXT_ICONS: Record<string, string> = {
  health: `<g transform="translate(60,60)">
    <rect x="0" y="40" width="160" height="60" fill="#E63946"/>
    <rect x="50" y="0" width="60" height="160" fill="#E63946"/>
  </g>`,
  warning: `<g transform="translate(60,60)">
    <polygon points="80,0 160,160 0,160" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
    <rect x="74" y="50" width="14" height="60" fill="#0A0A0A"/>
    <circle cx="81" cy="130" r="9" fill="#0A0A0A"/>
  </g>`,
  building: `<g transform="translate(60,60)">
    <polygon points="80,0 160,40 0,40" fill="#FFFFFF"/>
    <rect x="0" y="40" width="160" height="14" fill="#FFFFFF"/>
    <rect x="20" y="60" width="20" height="80" fill="#FFFFFF"/>
    <rect x="60" y="60" width="20" height="80" fill="#FFFFFF"/>
    <rect x="100" y="60" width="20" height="80" fill="#FFFFFF"/>
    <rect x="140" y="60" width="20" height="80" fill="#FFFFFF"/>
    <rect x="0" y="146" width="160" height="14" fill="#FFFFFF"/>
  </g>`,
};

const STORY_ICONS = ["health", "warning", "building"];

interface SceneTime { id: string; start: number; end: number; }

/**
 * voice.vtt から「Story N from」「Today's word」の開始時刻を抽出してシーン境界を作る。
 * VTT 末尾の最終 cue の終了時刻 = 音声長 = 動画長。
 */
async function parseVttScenes(vttPath: string): Promise<{ scenes: SceneTime[]; audioEnd: number }> {
  const text = await fs.readFile(vttPath, "utf-8");
  const cues = parseVttCues(text);

  const findStart = (re: RegExp): number | undefined =>
    cues.find(c => re.test(c.text))?.start;

  const introStart = 0;
  const s1Start = findStart(/Story 1 from/i);
  const s2Start = findStart(/Story 2 from/i);
  const s3Start = findStart(/Story 3 from/i);
  const outroStart = findStart(/Today'?s word/i);
  const audioEnd = cues[cues.length - 1]?.end ?? 60;

  if (s1Start === undefined || s2Start === undefined || s3Start === undefined || outroStart === undefined) {
    throw new Error("[scenes] Could not locate scene boundaries in VTT");
  }

  return {
    scenes: [
      { id: "01-intro",  start: introStart, end: s1Start },
      { id: "02-story1", start: s1Start,    end: s2Start },
      { id: "03-story2", start: s2Start,    end: s3Start },
      { id: "04-story3", start: s3Start,    end: outroStart },
      { id: "05-outro",  start: outroStart, end: audioEnd },
    ],
    audioEnd,
  };
}

interface VttCue { start: number; end: number; text: string; }
function parseVttCues(text: string): VttCue[] {
  const cues: VttCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (m) {
      const start = toSec(m[1], m[2], m[3], m[4]);
      const end   = toSec(m[5], m[6], m[7], m[8]);
      // collect text lines until blank
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

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = enDate(date);

  const { scenes: timings, audioEnd } = await parseVttScenes(path.join(dir, "voice.vtt"));
  console.log(`[scenes] audio = ${audioEnd.toFixed(2)}s`);
  timings.forEach(t => console.log(`[scenes]   ${t.id}: ${t.start.toFixed(2)}s → ${t.end.toFixed(2)}s (${(t.end - t.start).toFixed(2)}s)`));

  const renderable = [
    { ...timings[0], svg: introScene(script, mmdd) },
    { ...timings[1], svg: storyScene(script.stories[0], 1, "#E63946", CONTEXT_ICONS[STORY_ICONS[0]], "cd") },
    { ...timings[2], svg: storyScene(script.stories[1], 2, "#0F1B3D", CONTEXT_ICONS[STORY_ICONS[1]], "kw") },
    { ...timings[3], svg: storyScene(script.stories[2], 3, "#0A0A0A", CONTEXT_ICONS[STORY_ICONS[2]], "sg") },
    { ...timings[4], svg: outroScene(script) },
  ];

  for (const sc of renderable) {
    const svgPath = path.join(dir, `_scene-${sc.id}.svg`);
    const pngPath = path.join(dir, `_scene-${sc.id}.png`);
    await fs.writeFile(svgPath, sc.svg, "utf-8");
    await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
    await fs.unlink(svgPath).catch(() => {});
  }

  // Encode each PNG to mp4 of its dynamic duration
  const segments: string[] = [];
  for (const sc of renderable) {
    const png = path.join(dir, `_scene-${sc.id}.png`);
    const mp4 = path.join(dir, `_scene-${sc.id}.mp4`);
    const duration = sc.end - sc.start;
    const totalFrames = Math.max(1, Math.round(duration * FPS));
    const zoomExpr = `min(zoom+0.0008,1.06)`;
    await run("ffmpeg", [
      "-y", "-loop", "1", "-i", png,
      "-vf", `zoompan=z='${zoomExpr}':d=${totalFrames}:s=${W}x${H}:fps=${FPS},format=yuv420p`,
      "-t", duration.toFixed(3),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
      mp4,
    ]);
    segments.push(mp4);
  }

  const listFile = path.join(dir, "_concat.txt");
  await fs.writeFile(listFile, segments.map(s => `file '${path.resolve(s)}'`).join("\n"), "utf-8");
  const bgVideo = path.join(dir, "_bg.mp4");
  await run("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c", "copy", bgVideo,
  ]);
  await fs.unlink(listFile).catch(() => {});

  console.log(`[scenes] bg video → ${bgVideo} (${audioEnd.toFixed(2)}s)`);
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function wrap(text: string, maxChars: number, maxLines = 3): string[] {
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
function enDate(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}
function flagImg(code: string, x: number, y: number, w: number): string {
  return `<image href="_assets/${code.toLowerCase()}.png" x="${x}" y="${y}" width="${w}" height="${(w * 0.66).toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
}

function introScene(s: Script, mmdd: string): string {
  const codes = s.stories.map(st => st.country.code);
  const flagW = 280;
  const gap = 30;
  const total = flagW * 3 + gap * 2;
  const flagY = 1450;
  const startX = (W - total) / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>
  <rect x="60" y="260" width="500" height="86" fill="#F5E63B"/>
  <text x="80" y="324" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <text x="60" y="540" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#FFFFFF" letter-spacing="-3">TODAY'S</text>
  <text x="60" y="700" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#FFFFFF" letter-spacing="-3">3 STORIES.</text>
  <text x="60" y="1180" font-family="Hiragino Sans" font-weight="900"
        font-size="420" fill="#E63946" letter-spacing="-8">60s</text>
  ${flagImg(codes[0], startX,                  flagY, flagW)}
  ${flagImg(codes[1], startX + flagW + gap,    flagY, flagW)}
  ${flagImg(codes[2], startX + (flagW + gap)*2,flagY, flagW)}
  <text x="60" y="1820" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1870" font-family="Hiragino Sans" font-weight="600"
        font-size="34" fill="#7A7A7A" letter-spacing="2">@60dailyworld</text>
</svg>`;
}

/** Story scene with full-bleed photo background + dark gradient overlay. */
function storyScene(st: Story, idx: number, accentColor: string, contextIcon: string, bgCode: string): string {
  const code = st.country.code.toLowerCase();
  const headlineLines = wrap(st.headline, 20, 3);
  const startY = 1340;
  const lineHeight = 110;
  let headlineSvg = "";
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${startY + i * lineHeight}"
        font-family="Hiragino Sans" font-weight="900"
        font-size="90" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  const accentIsBright = accentColor.toLowerCase() === "#f5e63b";
  const onAccentText = accentIsBright ? "#0A0A0A" : "#FFFFFF";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="darken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.85"/>
      <stop offset="35%" stop-color="${accentColor}" stop-opacity="0.55"/>
      <stop offset="65%" stop-color="#0A0A0A" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.95"/>
    </linearGradient>
  </defs>

  <!-- Background photo (CC-BY-SA, Wikimedia) -->
  <image href="_assets/bg-${bgCode}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <!-- Dark overlay so text reads cleanly -->
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top accent strip kept thin for hierarchy (60px) -->
  <rect x="0" y="0" width="${W}" height="60" fill="${accentColor}"/>
  <text x="60" y="180" font-family="Hiragino Sans" font-weight="900"
        font-size="52" fill="${onAccentText}" letter-spacing="6">STORY ${idx} / 3</text>

  <!-- Flag PNG -->
  <image href="_assets/${code}.png" x="60" y="260" width="440" height="290"
         preserveAspectRatio="xMidYMid meet"/>

  <!-- ISO code -->
  <text x="1020" y="510" text-anchor="end" font-family="Hiragino Sans" font-weight="900"
        font-size="200" fill="#FFFFFF" letter-spacing="-4">${escape(st.country.code)}</text>

  <!-- Context icon -->
  <g transform="translate(820, 700) scale(1.3)">${contextIcon}</g>

  <!-- Source -->
  <text x="60" y="850" font-family="Hiragino Sans" font-weight="900"
        font-size="50" fill="#F5E63B" letter-spacing="6">${escape(st.sourceName.toUpperCase())}</text>
  <rect x="60" y="890" width="280" height="8" fill="#F5E63B"/>

  <text x="60" y="1050" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#E5E7EB" letter-spacing="6">HEADLINE</text>

  ${headlineSvg}
</svg>`;
}

/** Outro: today's word + PLEASE SUBSCRIBE + 👍 SVG + channel. Holds while voice plays. */
function outroScene(s: Script): string {
  const thumbUp = `<g transform="translate(760, 1110) scale(1.6)">
    <path d="M0 60 L0 200 L100 200 L150 140 L150 90 L100 90 L120 30 Q120 0 90 0 L70 0 L40 60 Z"
          fill="#F5E63B" stroke="#0A0A0A" stroke-width="6" stroke-linejoin="round"/>
    <rect x="-40" y="60" width="40" height="140" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
  </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Today's word card -->
  <rect x="60" y="180" width="960" height="500" fill="#F5E63B"/>
  <text x="100" y="280" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#0A0A0A" letter-spacing="6">TODAY'S WORD</text>
  <text x="100" y="470" font-family="Hiragino Sans" font-weight="900"
        font-size="170" fill="#0A0A0A" letter-spacing="-3">${escape(s.todaysWord.word)}</text>
  <text x="100" y="580" font-family="Hiragino Sans" font-weight="600"
        font-size="46" fill="#0A0A0A" letter-spacing="0">${escape(s.todaysWord.definitionEn.slice(0, 56))}</text>

  <!-- CTA -->
  <text x="60" y="900" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#FFFFFF" letter-spacing="-3">PLEASE</text>
  <text x="60" y="1050" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#F5E63B" letter-spacing="-3">SUBSCRIBE</text>

  ${thumbUp}

  <!-- Channel block -->
  <rect x="60" y="1480" width="960" height="320" fill="#0A0A0A"/>
  <text x="540" y="1600" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="92" fill="#F5E63B" letter-spacing="2">DAILY WORLD 60</text>
  <text x="540" y="1690" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="60" fill="#FFFFFF" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1760" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="34" fill="#7A8AB5" letter-spacing="3">YouTube · TikTok · Instagram</text>
</svg>`;
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
