import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 60秒動画用 5 シーン生成 (v3, all-English variant)。
 *
 * 構成:
 *   0–3s    Intro       BIG type + 3 flag PNGs + brand
 *   3–19s   Story 1     Flag PNG + ISO + context icon + headline (English)
 *   19–35s  Story 2     同上
 *   35–51s  Story 3     同上
 *   51–60s  Outro       Today's word card + PLEASE SUBSCRIBE + 👍 SVG path + @60dailyworld
 *
 * 修正点:
 *   - 全文字列を英語化 (日英混在禁止)
 *   - 国旗を Apple Color Emoji ではなく flag PNG (flagcdn 由来) で <image href="..."> 埋め込み
 *   - text size を控えめにし、wrap を厳しく (1080px viewbox に収まる)
 *   - Outro に thumb-up SVG path + Subscribe CTA
 *
 * カラー (research-brief-2026 準拠):
 *   ink #0A0A0A / navy #0F1B3D / red #E63946 / yellow #F5E63B / white #FFFFFF
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
  hook: string;
  stories: Story[];
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
  close: string;
}

const SCENES = [
  { id: "01-intro",   start: 0,  end: 3 },
  { id: "02-story1",  start: 3,  end: 19 },
  { id: "03-story2",  start: 19, end: 35 },
  { id: "04-story3",  start: 35, end: 51 },
  { id: "05-outro",   start: 51, end: 60 },
];

// Story-level context icon SVG paths (drawn inline)
const CONTEXT_ICONS: Record<string, string> = {
  // medical cross
  health: `<g transform="translate(60,60)">
    <rect x="0" y="40" width="160" height="60" fill="#E63946"/>
    <rect x="50" y="0" width="60" height="160" fill="#E63946"/>
  </g>`,
  // warning triangle
  warning: `<g transform="translate(60,60)">
    <polygon points="80,0 160,160 0,160" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
    <rect x="74" y="50" width="14" height="60" fill="#0A0A0A"/>
    <circle cx="81" cy="130" r="9" fill="#0A0A0A"/>
  </g>`,
  // government building (defense summit)
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

// Country code → context icon mapping (by story topic)
const STORY_ICONS = ["health", "warning", "building"]; // matches Congo Ebola, Iran missile, SG defense summit

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = enDate(date);

  const scenes = [
    { ...SCENES[0], svg: introScene(script, mmdd) },
    { ...SCENES[1], svg: storyScene(script.stories[0], 1, "#E63946", CONTEXT_ICONS[STORY_ICONS[0]]) },
    { ...SCENES[2], svg: storyScene(script.stories[1], 2, "#0F1B3D", CONTEXT_ICONS[STORY_ICONS[1]]) },
    { ...SCENES[3], svg: storyScene(script.stories[2], 3, "#0A0A0A", CONTEXT_ICONS[STORY_ICONS[2]]) },
    { ...SCENES[4], svg: outroScene(script) },
  ];

  for (const sc of scenes) {
    const svgPath = path.join(dir, `_scene-${sc.id}.svg`);
    const pngPath = path.join(dir, `_scene-${sc.id}.png`);
    await fs.writeFile(svgPath, sc.svg, "utf-8");
    await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
    await fs.unlink(svgPath).catch(() => {});
    console.log(`[scenes] ${pngPath}`);
  }

  // Each PNG → mp4 segment with light zoompan
  const segments: string[] = [];
  for (const sc of scenes) {
    const png = path.join(dir, `_scene-${sc.id}.png`);
    const mp4 = path.join(dir, `_scene-${sc.id}.mp4`);
    const duration = sc.end - sc.start;
    const totalFrames = duration * FPS;
    const zoomExpr = `min(zoom+0.0008,1.06)`;
    await run("ffmpeg", [
      "-y", "-loop", "1", "-i", png,
      "-vf", `zoompan=z='${zoomExpr}':d=${totalFrames}:s=${W}x${H}:fps=${FPS},format=yuv420p`,
      "-t", String(duration),
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

  console.log(`[scenes] bg video → ${bgVideo}`);
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
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

/**
 * Intro: black bg, big TODAY'S WORLD, 3 flag PNGs in row, brand footer.
 * Asymmetric: yellow stripe top-left, hero number off-center.
 */
function introScene(s: Script, mmdd: string): string {
  // Flag PNGs are downloaded to _assets/{cd,kw,sg}.png
  const flagImg = (code: string, x: number, y: number, w: number) => {
    const filename = code.toLowerCase();
    return `<image href="_assets/${filename}.png" x="${x}" y="${y}" width="${w}" height="${w * 0.66}" preserveAspectRatio="xMidYMid meet"/>`;
  };
  const codes = s.stories.map(st => st.country.code);
  // 3 flags row: each 300x198, total 900, gap 30
  const flagY = 1450;
  const flagW = 280;
  const flagGap = 30;
  const totalFlags = flagW * 3 + flagGap * 2;
  const flagStartX = (W - totalFlags) / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>

  <!-- Top dateline stripe (asymmetric, left-aligned) -->
  <rect x="60" y="260" width="500" height="86" fill="#F5E63B"/>
  <text x="80" y="324" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="#0A0A0A" letter-spacing="6">${escape(mmdd.toUpperCase())} · WORLD</text>

  <!-- Big TODAY'S -->
  <text x="60" y="540" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#FFFFFF" letter-spacing="-3">TODAY'S</text>
  <text x="60" y="700" font-family="Hiragino Sans" font-weight="900"
        font-size="140" fill="#FFFFFF" letter-spacing="-3">3 STORIES.</text>

  <!-- Hero number 60 (off-center) -->
  <text x="60" y="1180" font-family="Hiragino Sans" font-weight="900"
        font-size="420" fill="#E63946" letter-spacing="-8">60s</text>

  <!-- 3 flag PNGs row -->
  ${flagImg(codes[0], flagStartX,                          flagY, flagW)}
  ${flagImg(codes[1], flagStartX + flagW + flagGap,        flagY, flagW)}
  ${flagImg(codes[2], flagStartX + (flagW + flagGap) * 2,  flagY, flagW)}

  <!-- Brand footer -->
  <text x="60" y="1820" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1870" font-family="Hiragino Sans" font-weight="600"
        font-size="34" fill="#7A7A7A" letter-spacing="2">@60dailyworld</text>
</svg>`;
}

/**
 * Story scene: flag PNG large, ISO code, source, headline (3-line wrap).
 * Context icon (medical/warning/building) at top-right corner.
 */
function storyScene(st: Story, idx: number, accentColor: string, contextIcon: string): string {
  const code = st.country.code.toLowerCase();
  // Headline wrap (max 18 chars * 3 lines)
  const headlineLines = wrap(st.headline, 20, 3);
  const startY = 1280;
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
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>

  <!-- Top accent block (header strip, off-center to break symmetry) -->
  <rect x="0" y="0" width="${W}" height="640" fill="${accentColor}"/>

  <!-- Story counter -->
  <text x="60" y="200" font-family="Hiragino Sans" font-weight="900"
        font-size="52" fill="${onAccentText}" letter-spacing="6">STORY ${idx} / 3</text>

  <!-- Flag PNG (large, left side) -->
  <image href="_assets/${code}.png" x="60" y="270" width="500" height="330"
         preserveAspectRatio="xMidYMid meet"/>

  <!-- ISO code (right side, paired with flag) -->
  <text x="1020" y="540" text-anchor="end" font-family="Hiragino Sans" font-weight="900"
        font-size="220" fill="${onAccentText}" letter-spacing="-4">${escape(st.country.code)}</text>

  <!-- Context icon (small, top-right of black area, ~240x240 px) -->
  <g transform="translate(820, 720) scale(1.3)">${contextIcon}</g>

  <!-- Source label -->
  <text x="60" y="850" font-family="Hiragino Sans" font-weight="900"
        font-size="50" fill="#F5E63B" letter-spacing="6">${escape(st.sourceName.toUpperCase())}</text>

  <!-- Yellow asymmetric underline -->
  <rect x="60" y="890" width="280" height="8" fill="#F5E63B"/>

  <!-- "HEADLINE" label -->
  <text x="60" y="1010" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#7A7A7A" letter-spacing="6">HEADLINE</text>

  ${headlineSvg}
</svg>`;
}

/**
 * Outro: today's word card, PLEASE SUBSCRIBE big, thumb-up SVG path, channel name.
 */
function outroScene(s: Script): string {
  // Thumb-up SVG path (simple outline)
  const thumbUp = `<g transform="translate(800, 1120) scale(1.4)">
    <path d="M0 60 L0 200 L100 200 L150 140 L150 90 L100 90 L120 30 Q120 0 90 0 L70 0 L40 60 Z"
          fill="#F5E63B" stroke="#0A0A0A" stroke-width="6" stroke-linejoin="round"/>
    <rect x="-40" y="60" width="40" height="140" fill="#F5E63B" stroke="#0A0A0A" stroke-width="6"/>
  </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Today's word card -->
  <rect x="60" y="220" width="960" height="500" fill="#F5E63B"/>
  <text x="100" y="320" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#0A0A0A" letter-spacing="6">TODAY'S WORD</text>
  <text x="100" y="510" font-family="Hiragino Sans" font-weight="900"
        font-size="170" fill="#0A0A0A" letter-spacing="-3">${escape(s.todaysWord.word)}</text>
  <text x="100" y="620" font-family="Hiragino Sans" font-weight="600"
        font-size="48" fill="#0A0A0A" letter-spacing="0">${escape(s.todaysWord.definitionEn)}</text>

  <!-- CTA: PLEASE SUBSCRIBE -->
  <text x="60" y="950" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#FFFFFF" letter-spacing="-3">PLEASE</text>
  <text x="60" y="1080" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#F5E63B" letter-spacing="-3">SUBSCRIBE</text>

  <!-- Thumb-up icon -->
  ${thumbUp}

  <!-- Channel signature -->
  <rect x="60" y="1500" width="960" height="280" fill="#0A0A0A"/>
  <text x="540" y="1620" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="84" fill="#F5E63B" letter-spacing="2">DAILY WORLD 60</text>
  <text x="540" y="1700" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#FFFFFF" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1760" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#7A8AB5" letter-spacing="3">YouTube · TikTok · Instagram</text>
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
