import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 投稿用画像を生成する (research-brief-2026.md 準拠)。
 *
 * 共通:
 *   - 単色背景 (グラデ禁止: AI slop tell)
 *   - Hiragino Sans W9 (font-weight 900) を主軸
 *   - 0-3 word hook (ThumbMagic 2026 — eye-tracking)
 *   - asymmetric, 1/3 line ヒーロー配置 (anti-AI-slop)
 *   - 国旗は単一要素として 60%+ scale、headline はラベル化
 *
 * カラー:
 *   ink    #0A0A0A
 *   navy   #0F1B3D  (Bloomberg-coded)
 *   red    #E63946  (BBC/CNN-coded urgency)
 *   yellow #F5E63B  (acid accent)
 *   white  #FFFFFF
 *
 * 出力:
 *   yt-thumbnail-h.png  (1280x720, YouTube Search/Browse)
 *   yt-thumbnail-v.png  (1080x1920, YouTube Shorts player)
 *   ig-reels-cover.png  (1080x1920, Reels grid preview)
 *   ig-feed.png         (1080x1080, Feed post)
 *   tiktok-cover.png    (1080x1920, TikTok cover)
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
  stories: Story[];
  todaysWord: { word: string; definitionJp: string };
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = date.slice(5).replace("-", "/");
  const flags = script.stories.map(s => s.country.flag);

  await renderSvg(
    path.join(dir, "yt-thumbnail-h.png"),
    youtubeHorizontal(script, mmdd, flags),
    1280, 720,
  );

  await renderSvg(
    path.join(dir, "yt-thumbnail-v.png"),
    youtubeVertical(script, mmdd, flags),
    1080, 1920,
  );

  await renderSvg(
    path.join(dir, "ig-reels-cover.png"),
    igReelsCover(script, mmdd, flags),
    1080, 1920,
  );

  await renderSvg(
    path.join(dir, "ig-feed.png"),
    igFeed(script, mmdd, flags),
    1080, 1080,
  );

  await renderSvg(
    path.join(dir, "tiktok-cover.png"),
    tiktokCover(script, mmdd, flags),
    1080, 1920,
  );

  console.log("[social] done");
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * YouTube horizontal 1280x720 — Search/Browse thumbnail.
 * 0-3 word hook ("世界3本") + big single flag + brand.
 * Anti-slop: asymmetric, 1/3 grid, no gradient, Hiragino Sans W9.
 */
function youtubeHorizontal(s: Script, mmdd: string, flags: string[]): string {
  const accent = "#E63946"; // urgency red — news brand
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <rect width="1280" height="720" fill="#0A0A0A"/>
  <!-- Left 60%: text -->
  <rect x="0" y="0" width="760" height="160" fill="${accent}"/>
  <text x="40" y="115" font-family="Hiragino Sans" font-weight="900"
        font-size="84" fill="#FFFFFF" letter-spacing="-2">今日、世界で。</text>
  <text x="40" y="320" font-family="Hiragino Sans" font-weight="900"
        font-size="200" fill="#FFFFFF" letter-spacing="-4">3本.</text>
  <text x="40" y="500" font-family="Hiragino Sans" font-weight="900"
        font-size="200" fill="#F5E63B" letter-spacing="-4">60秒.</text>
  <text x="40" y="640" font-family="Hiragino Sans" font-weight="600"
        font-size="42" fill="#FFFFFF" letter-spacing="6">${escape(mmdd)} · DAILY WORLD 60</text>
  <!-- Right 40%: stacked flags as identity (no face) -->
  <text x="900" y="280" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="180">${escape(flags[0])}</text>
  <text x="900" y="470" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="180">${escape(flags[1])}</text>
  <text x="900" y="660" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="180">${escape(flags[2])}</text>
</svg>`;
}

/**
 * YouTube vertical 1080x1920 — Shorts player thumbnail / IG Reels / TikTok cover variant.
 * Same composition but vertical; safe zones top 210 / bottom 320 (Reels) / 200 (TT) — center keeps 16:9 safe-crop.
 */
function youtubeVertical(s: Script, mmdd: string, flags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>
  <!-- Top hook (safe-crop visible) -->
  <rect x="60" y="280" width="450" height="92" fill="#F5E63B"/>
  <text x="84" y="350" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <text x="60" y="540" font-family="Hiragino Sans" font-weight="900"
        font-size="160" fill="#FFFFFF" letter-spacing="-3">今日、</text>
  <text x="60" y="700" font-family="Hiragino Sans" font-weight="900"
        font-size="160" fill="#FFFFFF" letter-spacing="-3">世界で。</text>
  <!-- Hero number 60 — off-center -->
  <text x="40" y="1180" font-family="Hiragino Sans" font-weight="900"
        font-size="540" fill="#E63946" letter-spacing="-8">60</text>
  <!-- Flags row, bottom right asymmetric -->
  <text x="60" y="1500" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="180">${escape(flags.join("  "))}</text>
  <!-- Brand footer (off-center) -->
  <text x="60" y="1700" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1750" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#7A7A7A" letter-spacing="2">@60dailyworld</text>
</svg>`;
}

/**
 * Instagram Reels cover 1080x1920.
 * Safe zones: top 210px (audio bar), bottom 320px (caption+actions), right 84-120px (icons).
 * Hook text Y range 200-600px from top, centered horizontally.
 */
function igReelsCover(s: Script, mmdd: string, flags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0F1B3D"/>
  <!-- Top safe (above 210) leave empty -->
  <!-- Hook block: Y 220-720 (safe zone) -->
  <rect x="60" y="220" width="380" height="78" fill="#F5E63B"/>
  <text x="84" y="282" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>
  <text x="60" y="440" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#FFFFFF" letter-spacing="-2">3カ国、</text>
  <text x="60" y="580" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#F5E63B" letter-spacing="-2">60秒で。</text>
  <!-- Mid: country code chips (newspaper-coded) -->
  ${s.stories.map((st, i) => {
    const y = 880 + i * 200;
    return `
  <rect x="60" y="${y - 80}" width="180" height="120" fill="#F5E63B"/>
  <text x="150" y="${y + 8}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="76" fill="#0A0A0A" letter-spacing="2">${escape(st.country.code)}</text>
  <text x="280" y="${y - 36}" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="84">${escape(st.country.flag)}</text>
  <text x="400" y="${y - 28}" font-family="Hiragino Sans" font-weight="900"
        font-size="36" fill="#F5E63B" letter-spacing="3">${escape(st.sourceName.toUpperCase())}</text>
  <text x="400" y="${y + 18}" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#FFFFFF" letter-spacing="-1">${escape(wrapOne(st.headline, 18))}</text>`;
  }).join("")}
  <!-- Footer (above bottom UI zone Y >= 1600) -->
  <text x="60" y="1560" font-family="Hiragino Sans" font-weight="600"
        font-size="42" fill="#9CA3AF" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

function wrapOne(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Instagram Feed post 1080x1080.
 * Bottom 40px margin (Reels-as-grid crop). Asymmetric 1/3 hero.
 */
function igFeed(s: Script, mmdd: string, flags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <rect width="1080" height="1080" fill="#F4F1EA"/>
  <!-- Newspaper-coded top stripe -->
  <rect x="60" y="60" width="960" height="6" fill="#0A0A0A"/>
  <rect x="60" y="80" width="960" height="2" fill="#0A0A0A"/>
  <text x="60" y="160" font-family="Hiragino Sans" font-weight="600"
        font-size="34" fill="#0A0A0A" letter-spacing="8">DAILY WORLD 60 · ${escape(mmdd)}</text>
  <!-- Hero hook -->
  <text x="60" y="320" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#0A0A0A" letter-spacing="-3">今日の3本</text>
  <text x="60" y="430" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#E63946" letter-spacing="-3">世界ニュース</text>
  <!-- 3 stories list — newspaper layout -->
  ${s.stories.map((st, i) => {
    const y = 580 + i * 130;
    return `
  <text x="60" y="${y}" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="58">${escape(st.country.flag)}</text>
  <text x="160" y="${y - 8}" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0A0A0A" letter-spacing="-1">${escape(wrapOne(st.headline, 28))}</text>
  <text x="160" y="${y + 38}" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A7A7A" letter-spacing="2">${escape(st.sourceName.toUpperCase())} · ${escape(st.country.code)}</text>`;
  }).join("")}
  <!-- Bottom signature, above 40px margin -->
  <text x="60" y="1010" font-family="Hiragino Sans" font-weight="900"
        font-size="32" fill="#0A0A0A" letter-spacing="6">@60dailyworld</text>
  <text x="1020" y="1010" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#7A7A7A" letter-spacing="2">YouTube · TikTok · Instagram</text>
</svg>`;
}

/**
 * TikTok cover 1080x1920 — top-third hook, mid emotive visual, bottom 200px clean.
 */
function tiktokCover(s: Script, mmdd: string, flags: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>
  <!-- Top hook (60% scale) -->
  <text x="60" y="280" font-family="Hiragino Sans" font-weight="900"
        font-size="60" fill="#F5E63B" letter-spacing="8">STOP SCROLLING</text>
  <text x="60" y="460" font-family="Hiragino Sans" font-weight="900"
        font-size="170" fill="#FFFFFF" letter-spacing="-3">世界で今</text>
  <text x="60" y="620" font-family="Hiragino Sans" font-weight="900"
        font-size="170" fill="#FFFFFF" letter-spacing="-3">起きてる3本</text>
  <!-- Mid: 3 stacked flag chips -->
  ${s.stories.map((st, i) => {
    const y = 870 + i * 200;
    return `
  <rect x="60" y="${y - 70}" width="960" height="160" fill="#1A1A1A" stroke="#F5E63B" stroke-width="3"/>
  <text x="100" y="${y + 30}" font-family="Apple Color Emoji, Noto Color Emoji, sans-serif"
        font-size="100">${escape(st.country.flag)}</text>
  <text x="260" y="${y - 4}" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#F5E63B" letter-spacing="2">${escape(st.country.code)} · STORY ${st.index}</text>
  <text x="260" y="${y + 50}" font-family="Hiragino Sans" font-weight="900"
        font-size="40" fill="#FFFFFF" letter-spacing="-1">${escape(wrapOne(st.headline, 24))}</text>`;
  }).join("")}
  <!-- Footer (above 200px clean zone) -->
  <text x="60" y="1680" font-family="Hiragino Sans" font-weight="900"
        font-size="52" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

async function renderSvg(outPath: string, svg: string, w: number, h: number): Promise<void> {
  const svgPath = outPath.replace(/\.png$/, ".svg");
  await fs.writeFile(svgPath, svg, "utf-8");
  await run("rsvg-convert", ["-w", String(w), "-h", String(h), svgPath, "-o", outPath]);
  await fs.unlink(svgPath).catch(() => {});
  const stat = await fs.stat(outPath);
  console.log(`[social] ${outPath} (${w}x${h}, ${(stat.size / 1024).toFixed(0)} KB)`);
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
