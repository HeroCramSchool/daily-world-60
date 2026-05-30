import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 投稿用画像 (v10): 各 story (cd/kw/sg) 個別に
 *   yt-thumbnail-h-{code}.png  (1280x720)
 *   yt-thumbnail-v-{code}.png  (1080x1920)
 *   ig-reels-cover-{code}.png  (1080x1920)
 *   ig-feed-{code}.png         (1080x1080)
 *   tiktok-cover-{code}.png    (1080x1920)
 *
 * カラー: ink #0A0A0A / navy #0F1B3D / red #E63946 / yellow #F5E63B / white #FFFFFF
 * フォント: Hiragino Sans
 * 動的 font: fitKeyword / fitCaption
 */

interface Country { code: string; flag: string; name?: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  keyword?: { word: string; definitionEn: string };
}
interface ScriptJson { date: string; stories: Story[]; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = enDate(date);

  for (const story of script.stories) {
    const code = story.country.code.toLowerCase();
    await renderSvg(path.join(dir, `yt-thumbnail-h-${code}.png`), youtubeHorizontal(story, mmdd), 1280, 720);
    await renderSvg(path.join(dir, `yt-thumbnail-v-${code}.png`), youtubeVertical(story, mmdd),   1080, 1920);
    await renderSvg(path.join(dir, `ig-reels-cover-${code}.png`), igReelsCover(story, mmdd),       1080, 1920);
    await renderSvg(path.join(dir, `ig-feed-${code}.png`),         igFeed(story, mmdd),             1080, 1080);
    await renderSvg(path.join(dir, `tiktok-cover-${code}.png`),    tiktokCover(story, mmdd),        1080, 1920);
  }

  console.log("[social] done");
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function enDate(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}
function fitKeywordFontSize(word: string, maxWidth = 900, ceilingFontSize = 220): number {
  const widthPerChar = 0.58;
  const ideal = Math.floor(maxWidth / Math.max(1, word.length) / widthPerChar);
  return Math.min(ceilingFontSize, ideal);
}
function fitCaption(text: string, boxW: number, boxH: number,
                    candidates = [56, 50, 46, 42, 38, 34, 30, 26]) {
  const widthPerChar = 0.62, lineGapRatio = 1.32;
  for (const fs of candidates) {
    const cpl = Math.max(8, Math.floor(boxW / (fs * widthPerChar)));
    const lines = wrapAll(text, cpl);
    const lh = Math.round(fs * lineGapRatio);
    if (lines.length * lh <= boxH) return { fontSize: fs, lines, lineHeight: lh };
  }
  const fs = candidates[candidates.length - 1];
  const cpl = Math.max(8, Math.floor(boxW / (fs * widthPerChar)));
  return { fontSize: fs, lines: wrapAll(text, cpl), lineHeight: Math.round(fs * lineGapRatio) };
}
function wrapAll(text: string, cpl: number): string[] {
  const lines: string[] = []; const words = text.split(/\s+/).filter(Boolean); let cur = "";
  for (const w of words) {
    if (w.length > cpl) { if (cur) { lines.push(cur); cur = ""; } for (let i=0;i<w.length;i+=cpl) lines.push(w.slice(i,i+cpl)); continue; }
    if ((cur + " " + w).trim().length > cpl) { if (cur) lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
function flagImg(code: string, x: number, y: number, w: number): string {
  return `<image href="_assets/${code.toLowerCase()}.png" x="${x}" y="${y}" width="${w}" height="${(w * 0.66).toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
}
function shortUrl(url: string, maxLen = 50): string {
  const t = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1) + "…";
}

/** YouTube horizontal 1280x720 — 1 story per video */
function youtubeHorizontal(s: Story, mmdd: string): string {
  const code = s.country.code.toLowerCase();
  const cn = s.country.name ?? s.country.code;
  const hlFit = fitCaption(s.headline, 880, 460, [60, 54, 48, 42, 38, 34, 30]);
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="40" y="${260 + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <rect width="1280" height="720" fill="#0A0A0A"/>
  <rect x="0" y="0" width="800" height="80" fill="#E63946"/>
  <text x="40" y="62" font-family="Hiragino Sans" font-weight="900"
        font-size="40" fill="#FFFFFF" letter-spacing="6">${escape(mmdd)} · ${escape(cn.toUpperCase())}</text>
  <text x="40" y="180" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>
  ${hlSvg}
  ${flagImg(code, 920, 100, 320)}
  <text x="40" y="690" font-family="Hiragino Sans" font-weight="600"
        font-size="22" fill="#7A7A7A" letter-spacing="3">DAILY WORLD 60 · @60dailyworld · ${escape(s.sourceName)}</text>
</svg>`;
}

/** YouTube Shorts vertical 1080x1920 */
function youtubeVertical(s: Story, mmdd: string): string {
  const code = s.country.code.toLowerCase();
  const cn = s.country.name ?? s.country.code;
  const cnFs = fitKeywordFontSize(cn.toUpperCase(), 940, 150);
  const hlFit = fitCaption(s.headline, 960, 500, [56, 50, 46, 42, 38, 34, 30]);
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="60" y="${1240 + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>
  <rect x="60" y="280" width="500" height="86" fill="#F5E63B"/>
  <text x="80" y="344" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <text x="60" y="490" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>
  ${flagImg(code, 60, 580, 380)}
  <text x="500" y="800" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2">${escape(cn.toUpperCase())}</text>
  <rect x="60" y="1150" width="220" height="8" fill="#F5E63B"/>
  <text x="60" y="1210" font-family="Hiragino Sans" font-weight="600"
        font-size="34" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  ${hlSvg}
  <text x="60" y="1800" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1860" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A7A7A" letter-spacing="2">@60dailyworld · ${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 40))}</text>
</svg>`;
}

/** IG Reels cover 1080x1920 */
function igReelsCover(s: Story, mmdd: string): string {
  const code = s.country.code.toLowerCase();
  const cn = s.country.name ?? s.country.code;
  const cnFs = fitKeywordFontSize(cn.toUpperCase(), 940, 150);
  const hlFit = fitCaption(s.headline, 960, 600, [60, 54, 48, 44, 40, 36, 32]);
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="540" y="${1080 + i * hlFit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0F1B3D"/>
  <rect x="60" y="220" width="500" height="80" fill="#F5E63B"/>
  <text x="80" y="282" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <text x="60" y="450" text-anchor="start" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>
  ${flagImg(code, 60, 540, 360)}
  <text x="480" y="750" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2">${escape(cn.toUpperCase())}</text>
  <text x="540" y="990" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  ${hlSvg}
  <text x="540" y="1560" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#FFFFFF" letter-spacing="6">@60dailyworld</text>
  <text x="540" y="1610" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#9CA3AF" letter-spacing="2">${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 45))}</text>
</svg>`;
}

/** IG Feed 1080x1080 — newspaper-style */
function igFeed(s: Story, mmdd: string): string {
  const code = s.country.code.toLowerCase();
  const cn = s.country.name ?? s.country.code;
  const hlFit = fitCaption(s.headline, 960, 380, [54, 48, 42, 38, 34, 30, 26]);
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="60" y="${380 + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#0A0A0A" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <rect width="1080" height="1080" fill="#F4F1EA"/>
  <rect x="60" y="60" width="960" height="6" fill="#0A0A0A"/>
  <rect x="60" y="80" width="960" height="2" fill="#0A0A0A"/>
  <text x="60" y="150" font-family="Hiragino Sans" font-weight="600"
        font-size="30" fill="#0A0A0A" letter-spacing="8">DAILY WORLD 60 · ${escape(mmdd)} · ${escape(cn.toUpperCase())}</text>
  ${flagImg(code, 60, 200, 220)}
  <text x="320" y="280" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#E63946" letter-spacing="-2">TODAY'S NEWS</text>
  ${hlSvg}
  <rect x="60" y="950" width="960" height="2" fill="#0A0A0A"/>
  <text x="60" y="1010" font-family="Hiragino Sans" font-weight="900"
        font-size="28" fill="#0A0A0A" letter-spacing="6">@60dailyworld</text>
  <text x="1020" y="1010" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="22" fill="#7A7A7A" letter-spacing="2">${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 40))}</text>
</svg>`;
}

/** TikTok cover 1080x1920 */
function tiktokCover(s: Story, mmdd: string): string {
  const code = s.country.code.toLowerCase();
  const cn = s.country.name ?? s.country.code;
  const cnFs = fitKeywordFontSize(cn.toUpperCase(), 940, 150);
  const hlFit = fitCaption(s.headline, 960, 600, [56, 50, 46, 42, 38, 34, 30]);
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="540" y="${1040 + i * hlFit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>
  <text x="60" y="280" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#F5E63B" letter-spacing="8">STOP SCROLLING</text>
  <text x="60" y="430" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#FFFFFF" letter-spacing="-2">TODAY'S NEWS</text>
  ${flagImg(code, 60, 540, 360)}
  <text x="480" y="750" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#F5E63B" letter-spacing="-2">${escape(cn.toUpperCase())}</text>
  <text x="540" y="960" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  ${hlSvg}
  <text x="540" y="1680" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="52" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1730" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#9CA3AF" letter-spacing="2">${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 45))}</text>
</svg>`;
}

async function renderSvg(outPath: string, svg: string, w: number, h: number): Promise<void> {
  const svgPath = outPath.replace(/\.png$/, ".svg");
  await fs.writeFile(svgPath, svg, "utf-8");
  await run("rsvg-convert", ["-w", String(w), "-h", String(h), svgPath, "-o", outPath]);
  await fs.unlink(svgPath).catch(() => {});
  const stat = await fs.stat(outPath);
  console.log(`[social] ${path.basename(outPath)} (${w}x${h}, ${(stat.size / 1024).toFixed(0)} KB)`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
