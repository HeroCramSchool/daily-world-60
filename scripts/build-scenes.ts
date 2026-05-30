import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 60秒動画を 5 シーンに分割して背景 PNG を生成し、ffmpeg で合成する。
 * 構成 (research-brief-2026.md 準拠):
 *   0–3s    Intro hook (DAILY WORLD 60 + 3 国旗)
 *   3–19s   Story 1
 *   19–35s  Story 2
 *   35–51s  Story 3
 *   51–60s  Today's Word + Outro CTA
 *
 * 各シーンは Hiragino Sans W9 (黒)、anti-AI-slop の単色背景 (グラデなし)。
 * カラーパレット:
 *   navy   #0F1B3D
 *   red    #E63946
 *   yellow #F5E63B
 *   ink    #0A0A0A
 *   white  #FFFFFF
 *
 * 字幕は ffmpeg subtitles filter で別途 burn-in (voice.vtt 利用)。
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

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = date.slice(5).replace("-", "/");

  const scenes = [
    { ...SCENES[0], svg: introScene(script, mmdd) },
    { ...SCENES[1], svg: storyScene(script.stories[0], 1, "#E63946") }, // red — urgency
    { ...SCENES[2], svg: storyScene(script.stories[1], 2, "#0F1B3D") }, // navy — serious
    { ...SCENES[3], svg: storyScene(script.stories[2], 3, "#0A0A0A") }, // ink — focus
    { ...SCENES[4], svg: outroScene(script, mmdd) },
  ];

  for (const sc of scenes) {
    const svgPath = path.join(dir, `_scene-${sc.id}.svg`);
    const pngPath = path.join(dir, `_scene-${sc.id}.png`);
    await fs.writeFile(svgPath, sc.svg, "utf-8");
    await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
    await fs.unlink(svgPath).catch(() => {});
    console.log(`[scenes] ${pngPath}`);
  }

  // 各 PNG を duration 分の mp4 にする (ken-burns 風 zoompan)
  const segments: string[] = [];
  for (const sc of scenes) {
    const png = path.join(dir, `_scene-${sc.id}.png`);
    const mp4 = path.join(dir, `_scene-${sc.id}.mp4`);
    const duration = sc.end - sc.start;
    const totalFrames = duration * FPS;
    // 1.0 -> 1.06 緩いズームイン
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

  // Concat scenes
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
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur.trim());
  return lines;
}

/** Intro: ink #0A0A0A + yellow accent + 3 flags */
function introScene(s: Script, mmdd: string): string {
  const flags = s.stories.map(st => st.country.flag).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0A0A0A"/>
  <!-- Dateline strip top -->
  <rect x="60" y="220" width="380" height="74" fill="#F5E63B"/>
  <text x="80" y="276" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <!-- DAILY WORLD -->
  <text x="60" y="440" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#FFFFFF" letter-spacing="-2">DAILY</text>
  <text x="60" y="560" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#FFFFFF" letter-spacing="-2">WORLD</text>
  <!-- 60 -->
  <text x="60" y="900" font-family="Hiragino Sans" font-weight="900"
        font-size="420" fill="#F5E63B" letter-spacing="-8">60</text>
  <!-- Hook line -->
  <text x="60" y="1080" font-family="Hiragino Sans" font-weight="600"
        font-size="58" fill="#FFFFFF" letter-spacing="0">3カ国の今日。</text>
  <text x="60" y="1150" font-family="Hiragino Sans" font-weight="600"
        font-size="58" fill="#FFFFFF" letter-spacing="0">60秒で。</text>
  <!-- Flags row -->
  <text x="60" y="1500" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="170">${escape(flags)}</text>
  <!-- Footer @ off-center to dodge AI-slop symmetry -->
  <text x="60" y="1820" font-family="Hiragino Sans" font-weight="600"
        font-size="38" fill="#7A7A7A" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

/** Story scene: bold flag + country + headline. accentColor: red / navy / ink */
function storyScene(st: Story, idx: number, accentColor: string): string {
  // text color contrast
  const accentIsLight = accentColor.toLowerCase() === "#f5e63b";
  const bg = "#0A0A0A";
  const headlineLines = wrap(st.headline, 22).slice(0, 3);
  const lineHeight = 100;
  const startY = 1000;
  let headlineSvg = "";
  headlineLines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${startY + i * lineHeight}"
        font-family="Hiragino Sans" font-weight="900"
        font-size="92" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <!-- Diagonal accent strip 1/3 line, off-center -->
  <rect x="0" y="0" width="${W}" height="540" fill="${accentColor}"/>
  <!-- Story counter (newspaper-coded) -->
  <text x="60" y="200" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="${accentIsLight ? "#0A0A0A" : "#FFFFFF"}" letter-spacing="6">STORY ${idx} / 3</text>
  <!-- Big flag (60% scale) -->
  <text x="60" y="450" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="320">${escape(st.country.flag)}</text>
  <!-- Country code (right side, ExtraBold) -->
  <text x="980" y="450" text-anchor="end" font-family="Hiragino Sans" font-weight="900"
        font-size="220" fill="${accentIsLight ? "#0A0A0A" : "#FFFFFF"}" letter-spacing="-4">${escape(st.country.code)}</text>
  <!-- Source label (small, top of black area) -->
  <text x="60" y="660" font-family="Hiragino Sans" font-weight="600"
        font-size="44" fill="#F5E63B" letter-spacing="4">${escape(st.sourceName.toUpperCase())}</text>
  <!-- Yellow underline 1/3 length, off-center asymmetric -->
  <rect x="60" y="700" width="280" height="6" fill="#F5E63B"/>
  <!-- Headline -->
  ${headlineSvg}
</svg>`;
}

/** Outro: today's word card + CTA */
function outroScene(s: Script, mmdd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>
  <!-- Today's word card -->
  <rect x="60" y="320" width="960" height="500" fill="#F5E63B"/>
  <text x="100" y="430" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0A0A0A" letter-spacing="6">今日の英単語</text>
  <text x="100" y="630" font-family="Hiragino Sans" font-weight="900"
        font-size="180" fill="#0A0A0A" letter-spacing="-2">${escape(s.todaysWord.word)}</text>
  <text x="100" y="760" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#0A0A0A" letter-spacing="0">= ${escape(s.todaysWord.definitionJp)}</text>
  <!-- CTA -->
  <text x="60" y="1300" font-family="Hiragino Sans" font-weight="900"
        font-size="100" fill="#FFFFFF" letter-spacing="-1">明日も60秒。</text>
  <text x="60" y="1420" font-family="Hiragino Sans" font-weight="900"
        font-size="100" fill="#FFFFFF" letter-spacing="-1">フォローを。</text>
  <!-- Signature -->
  <text x="60" y="1700" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
  <text x="60" y="1780" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#7A8AB5" letter-spacing="2">YouTube · TikTok · Instagram</text>
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
