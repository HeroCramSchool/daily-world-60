import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 投稿用画像を 4 種類生成する:
 * - YouTube サムネ (1280x720)
 * - Instagram フィード (1080x1080)
 * - Instagram ストーリー (1080x1920)
 * - X (Twitter) カード (1200x675)
 *
 * すべて script-en.json の 3 ストーリーを使う。
 */

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
  todaysWord: { word: string; definitionJp: string };
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  const mmdd = date.slice(5).replace("-", "/");

  // 1. YouTube thumbnail 1280x720
  await renderSvg(
    path.join(dir, "yt-thumbnail.png"),
    youtubeThumbnail(script, mmdd),
    1280,
    720,
  );

  // 2. Instagram feed 1080x1080
  await renderSvg(
    path.join(dir, "ig-feed.png"),
    instagramFeed(script, mmdd),
    1080,
    1080,
  );

  // 3. Instagram story / Reels cover 1080x1920
  await renderSvg(
    path.join(dir, "ig-story.png"),
    instagramStory(script, mmdd),
    1080,
    1920,
  );

  // 4. X card 1200x675
  await renderSvg(
    path.join(dir, "x-card.png"),
    xCard(script, mmdd),
    1200,
    675,
  );

  console.log("[social-images] done");
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function youtubeThumbnail(s: Script, mmdd: string): string {
  const flags = s.stories.map(st => st.country.flag).join("  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect x="60" y="60" width="180" height="60" rx="16" fill="#DC2626"/>
  <text x="150" y="103" text-anchor="middle" font-family="Helvetica, Arial Black, sans-serif"
        font-size="32" font-weight="900" fill="#FFFFFF" letter-spacing="3">LIVE NEWS</text>
  <text x="60" y="240" font-family="Helvetica, Arial Black, sans-serif"
        font-size="120" font-weight="900" fill="#FFFFFF">DAILY WORLD</text>
  <text x="60" y="360" font-family="Helvetica, Arial Black, sans-serif"
        font-size="200" font-weight="900" fill="#FBBF24" letter-spacing="8">60</text>
  <text x="60" y="500" font-family="Helvetica, Arial, sans-serif"
        font-size="48" font-weight="700" fill="#E2E8F0">${escape(mmdd)} · TOP 3 stories</text>
  <text x="60" y="630" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"
        font-size="120">${escape(flags)}</text>
  <text x="1220" y="700" text-anchor="end" font-family="Helvetica, sans-serif"
        font-size="24" font-weight="600" fill="#94A3B8">@60dailyworld</text>
</svg>`;
}

function instagramFeed(s: Script, mmdd: string): string {
  // 1080x1080: top: date + flags. middle: 3 headlines. bottom: brand.
  let storyBlocks = "";
  s.stories.forEach((st, i) => {
    const y = 360 + i * 200;
    const lines = wrap(st.headline, 24).slice(0, 2);
    storyBlocks += `
    <text x="60" y="${y}" font-family="Apple Color Emoji, sans-serif" font-size="80">${escape(st.country.flag)}</text>
    <text x="180" y="${y - 20}" font-family="Helvetica, sans-serif"
          font-size="28" font-weight="700" fill="#FBBF24" letter-spacing="2">${escape(st.country.code)} · ${escape(st.sourceName)}</text>
    ${lines.map((l, j) => `<text x="180" y="${y + 30 + j * 38}" font-family="Helvetica, Arial Black, sans-serif"
          font-size="34" font-weight="800" fill="#FFFFFF">${escape(l)}</text>`).join("\n    ")}`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  <rect x="60" y="60" width="220" height="60" rx="16" fill="#DC2626"/>
  <text x="170" y="103" text-anchor="middle" font-family="Helvetica, Arial Black, sans-serif"
        font-size="32" font-weight="900" fill="#FFFFFF" letter-spacing="3">DAILY · ${escape(mmdd)}</text>
  <text x="60" y="240" font-family="Helvetica, Arial Black, sans-serif"
        font-size="80" font-weight="900" fill="#FFFFFF">3 stories.</text>
  <text x="60" y="320" font-family="Helvetica, Arial Black, sans-serif"
        font-size="80" font-weight="900" fill="#FBBF24">60 seconds.</text>
  ${storyBlocks}
  <text x="540" y="1020" text-anchor="middle" font-family="Helvetica, sans-serif"
        font-size="30" font-weight="700" fill="#E2E8F0" letter-spacing="6">@60dailyworld</text>
</svg>`;
}

function instagramStory(s: Script, mmdd: string): string {
  let storyBlocks = "";
  s.stories.forEach((st, i) => {
    const y = 760 + i * 280;
    const lines = wrap(st.headline, 22).slice(0, 2);
    storyBlocks += `
    <text x="80" y="${y}" font-family="Apple Color Emoji, sans-serif" font-size="100">${escape(st.country.flag)}</text>
    <text x="220" y="${y - 30}" font-family="Helvetica, sans-serif"
          font-size="34" font-weight="700" fill="#FBBF24" letter-spacing="3">${escape(st.country.code)} · ${escape(st.sourceName)}</text>
    ${lines.map((l, j) => `<text x="220" y="${y + 30 + j * 50}" font-family="Helvetica, Arial Black, sans-serif"
          font-size="44" font-weight="800" fill="#FFFFFF">${escape(l)}</text>`).join("\n    ")}`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <rect x="80" y="160" width="280" height="80" rx="20" fill="#DC2626"/>
  <text x="220" y="218" text-anchor="middle" font-family="Helvetica, Arial Black, sans-serif"
        font-size="44" font-weight="900" fill="#FFFFFF" letter-spacing="4">${escape(mmdd)}</text>
  <text x="80" y="400" font-family="Helvetica, Arial Black, sans-serif"
        font-size="110" font-weight="900" fill="#FFFFFF">DAILY WORLD</text>
  <text x="80" y="540" font-family="Helvetica, Arial Black, sans-serif"
        font-size="220" font-weight="900" fill="#FBBF24" letter-spacing="8">60</text>
  <text x="80" y="640" font-family="Helvetica, sans-serif"
        font-size="38" font-weight="700" fill="#E2E8F0">Three stories. Sixty seconds. Every day.</text>
  ${storyBlocks}
  <rect x="80" y="1700" width="920" height="120" rx="24" fill="rgba(255,255,255,0.1)"/>
  <text x="540" y="1745" text-anchor="middle" font-family="Helvetica, sans-serif"
        font-size="32" font-weight="700" fill="#FBBF24" letter-spacing="4">TODAY'S WORD</text>
  <text x="540" y="1795" text-anchor="middle" font-family="Helvetica, Arial Black, sans-serif"
        font-size="44" font-weight="900" fill="#FFFFFF">${escape(s.todaysWord.word)} = ${escape(s.todaysWord.definitionJp)}</text>
  <text x="540" y="1870" text-anchor="middle" font-family="Helvetica, sans-serif"
        font-size="28" font-weight="700" fill="#94A3B8" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

function xCard(s: Script, mmdd: string): string {
  const flags = s.stories.map(st => st.country.flag).join("  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="1200" height="675">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <text x="60" y="120" font-family="Helvetica, Arial Black, sans-serif"
        font-size="48" font-weight="700" fill="#FBBF24" letter-spacing="4">${escape(mmdd)} · 世界ニュース TOP3</text>
  <text x="60" y="240" font-family="Helvetica, Arial Black, sans-serif"
        font-size="92" font-weight="900" fill="#FFFFFF">DAILY WORLD</text>
  <text x="60" y="380" font-family="Helvetica, Arial Black, sans-serif"
        font-size="180" font-weight="900" fill="#FBBF24" letter-spacing="6">60</text>
  <text x="60" y="500" font-family="Helvetica, sans-serif"
        font-size="36" font-weight="600" fill="#E2E8F0">3カ国・3記事・60秒</text>
  <text x="60" y="610" font-family="Apple Color Emoji, sans-serif" font-size="100">${escape(flags)}</text>
  <text x="1140" y="655" text-anchor="end" font-family="Helvetica, sans-serif"
        font-size="24" font-weight="600" fill="#94A3B8">@60dailyworld</text>
</svg>`;
}

async function renderSvg(outPath: string, svg: string, w: number, h: number): Promise<void> {
  const svgPath = outPath.replace(/\.png$/, ".svg");
  await fs.writeFile(svgPath, svg, "utf-8");
  await run("rsvg-convert", ["-w", String(w), "-h", String(h), svgPath, "-o", outPath]);
  await fs.unlink(svgPath).catch(() => {});
  const stat = await fs.stat(outPath);
  console.log(`[social-images] ${outPath} (${w}x${h}, ${stat.size} bytes)`);
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
