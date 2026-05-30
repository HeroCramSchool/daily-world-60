import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 投稿用画像 (v11): 動画と同じ Wikipedia 背景画像 + dark overlay + 動的フォント。
 *
 * 出力 (各 story / cd, kw, sg):
 *   yt-thumbnail-h-{code}.png  (1280x720)  YouTube Search/Browse
 *   yt-thumbnail-v-{code}.png  (1080x1920) YouTube Shorts player
 *   ig-reels-cover-{code}.png  (1080x1920) Instagram Reels
 *   ig-feed-{code}.png         (1080x1080) Instagram Feed (1:1)
 *   tiktok-cover-{code}.png    (1080x1920) TikTok
 *
 * 背景: _assets/bg-{code}-{1,2}.jpg (CC-BY-SA, 動画と共通)
 * フォント: Hiragino Sans, 全 text に fitCaption / fitKeywordFontSize
 * カラー: ink #0A0A0A / navy #0F1B3D / red #E63946 / yellow #F5E63B / white #FFFFFF
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
    // 縦長: bg-1 (主要メイン画像)
    // 横長 (1280x720): bg-2 (バリエーション)
    // 1:1: bg-1 中央 crop
    await renderSvg(path.join(dir, `yt-thumbnail-h-${code}.png`),  ytHorizontal(story, mmdd, code, 2), 1280, 720);
    await renderSvg(path.join(dir, `yt-thumbnail-v-${code}.png`),  vertical(story, mmdd, code, 1),    1080, 1920);
    await renderSvg(path.join(dir, `ig-reels-cover-${code}.png`),  vertical(story, mmdd, code, 1),    1080, 1920);
    await renderSvg(path.join(dir, `ig-feed-${code}.png`),         square(story, mmdd, code, 1),      1080, 1080);
    await renderSvg(path.join(dir, `tiktok-cover-${code}.png`),    vertical(story, mmdd, code, 1),    1080, 1920);
  }

  console.log("[social] done");
}

// ─── helpers ───

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function enDate(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}
function fitKeywordFontSize(word: string, maxWidth: number, ceiling: number): number {
  const widthPerChar = 0.6;
  const ideal = Math.floor(maxWidth / Math.max(1, word.length) / widthPerChar);
  return Math.min(ceiling, ideal);
}
function fitCaption(text: string, boxW: number, boxH: number,
                    candidates: number[]) {
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
function shortUrl(url: string, maxLen: number): string {
  const t = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1) + "…";
}

/** 共通の darken gradient defs */
function darkenDefs(): string {
  return `<defs>
    <linearGradient id="darken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"  stop-color="#0A0A0A" stop-opacity="0.85"/>
      <stop offset="35%" stop-color="#0A0A0A" stop-opacity="0.45"/>
      <stop offset="65%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.95"/>
    </linearGradient>
  </defs>`;
}

// ─── 縦長 1080x1920 (YT Shorts / IG Reels / TikTok 共通レイアウト) ───
function vertical(s: Story, mmdd: string, code: string, bgN: number): string {
  const W = 1080, H = 1920;
  const cn = (s.country.name ?? s.country.code).toUpperCase();
  const cnFs = fitKeywordFontSize(cn, 920, 130);

  // Top yellow date stripe + TODAY'S NEWS
  // Mid: 国名大字 + 国旗 small
  // Bottom box: headline (fitCaption Y 1220-1700, 480px)
  // Footer: channel + source
  const hlFit = fitCaption(s.headline, 960, 480,
                           [56, 50, 46, 42, 38, 34, 30, 26]);
  const hlBoxY = 1220, hlBoxH = 480;
  const hlStartY = hlBoxY + (hlBoxH - hlFit.lines.length * hlFit.lineHeight) / 2 + hlFit.fontSize;
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="540" y="${hlStartY + i * hlFit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${darkenDefs()}
  <image href="_assets/bg-${code}-${bgN}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top: date stripe -->
  <rect x="60" y="220" width="500" height="86" fill="#F5E63B"/>
  <text x="80" y="284" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>

  <!-- TODAY'S NEWS -->
  <text x="60" y="460" font-family="Hiragino Sans" font-weight="900"
        font-size="80" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>

  <!-- 国旗 + 国名 -->
  <image href="_assets/${code}.png" x="60" y="560" width="280" height="190"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="380" y="740" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2">${escape(cn)}</text>

  <!-- Headline 区切り -->
  <text x="60" y="1160" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#9CA3AF" letter-spacing="6">HEADLINE</text>
  <rect x="60" y="1180" width="220" height="6" fill="#F5E63B"/>

  <!-- Headline box (Y 1220-1700) -->
  <rect x="40" y="${hlBoxY}" width="1000" height="${hlBoxH}" fill="#0A0A0A" fill-opacity="0.55" rx="20"/>
  ${hlSvg}

  <!-- Footer: channel + source (Y 1740-1900) -->
  <rect x="0" y="1740" width="${W}" height="180" fill="#0A0A0A" fill-opacity="0.92"/>
  <rect x="0" y="1740" width="${W}" height="3" fill="#F5E63B"/>
  <text x="540" y="1800" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60 · @60dailyworld</text>
  <text x="540" y="1855" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="22" fill="#9CA3AF" letter-spacing="2">SOURCE: ${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 48))}</text>
  <text x="540" y="1895" text-anchor="middle" font-family="Hiragino Sans" font-weight="500"
        font-size="18" fill="#6B7280" letter-spacing="1">Educational summary · Fair use (US §107 / JP 著作権法32条)</text>
</svg>`;
}

// ─── 横長 1280x720 (YouTube Search) ───
function ytHorizontal(s: Story, mmdd: string, code: string, bgN: number): string {
  const W = 1280, H = 720;
  const cn = (s.country.name ?? s.country.code).toUpperCase();
  const cnFs = fitKeywordFontSize(cn, 480, 70);

  const hlFit = fitCaption(s.headline, 1200, 280,
                           [50, 46, 42, 38, 34, 30, 26]);
  const hlStartY = 380;
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="40" y="${hlStartY + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${darkenDefs()}
  <image href="_assets/bg-${code}-${bgN}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top stripe -->
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="40" y="46" font-family="Hiragino Sans" font-weight="900"
        font-size="32" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>

  <!-- TODAY'S NEWS + 国旗 + 国名 -->
  <text x="40" y="160" font-family="Hiragino Sans" font-weight="900"
        font-size="62" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>
  <image href="_assets/${code}.png" x="40" y="200" width="200" height="135"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="270" y="320" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2">${escape(cn)}</text>

  <!-- Headline -->
  ${hlSvg}

  <!-- Footer -->
  <rect x="0" y="660" width="${W}" height="60" fill="#0A0A0A" fill-opacity="0.92"/>
  <text x="40" y="700" font-family="Hiragino Sans" font-weight="600"
        font-size="22" fill="#F5E63B" letter-spacing="3">@60dailyworld · SOURCE: ${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 50))}</text>
</svg>`;
}

// ─── 1:1 1080x1080 (Instagram Feed) ───
function square(s: Story, mmdd: string, code: string, bgN: number): string {
  const W = 1080, H = 1080;
  const cn = (s.country.name ?? s.country.code).toUpperCase();
  const cnFs = fitKeywordFontSize(cn, 920, 110);

  const hlFit = fitCaption(s.headline, 960, 380,
                           [50, 46, 42, 38, 34, 30, 26]);
  const hlBoxY = 580, hlBoxH = 380;
  const hlStartY = hlBoxY + (hlBoxH - hlFit.lines.length * hlFit.lineHeight) / 2 + hlFit.fontSize;
  let hlSvg = "";
  hlFit.lines.forEach((line, i) => {
    hlSvg += `\n  <text x="540" y="${hlStartY + i * hlFit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1">${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${darkenDefs()}
  <image href="_assets/bg-${code}-${bgN}.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top stripe -->
  <rect x="60" y="60" width="400" height="74" fill="#F5E63B"/>
  <text x="80" y="115" font-family="Hiragino Sans" font-weight="900"
        font-size="38" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>

  <!-- TODAY'S NEWS -->
  <text x="60" y="240" font-family="Hiragino Sans" font-weight="900"
        font-size="60" fill="#F5E63B" letter-spacing="-2">TODAY'S NEWS</text>

  <!-- 国旗 + 国名 -->
  <image href="_assets/${code}.png" x="60" y="310" width="220" height="148"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="320" y="450" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2">${escape(cn)}</text>

  <!-- Headline box -->
  <rect x="40" y="${hlBoxY}" width="1000" height="${hlBoxH}" fill="#0A0A0A" fill-opacity="0.55" rx="20"/>
  ${hlSvg}

  <!-- Footer -->
  <rect x="0" y="990" width="${W}" height="90" fill="#0A0A0A" fill-opacity="0.92"/>
  <rect x="0" y="990" width="${W}" height="3" fill="#F5E63B"/>
  <text x="540" y="1030" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="34" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
  <text x="540" y="1065" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="18" fill="#9CA3AF" letter-spacing="2">SOURCE: ${escape(s.sourceName)} · ${escape(shortUrl(s.sourceUrl, 50))}</text>
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
