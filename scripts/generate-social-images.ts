import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * 投稿用画像 (v3, English-only). 国旗は flag PNG (flagcdn) を <image> 埋め込み。
 *
 * カラー: ink #0A0A0A / navy #0F1B3D / red #E63946 / yellow #F5E63B / white #FFFFFF
 * フォント: Hiragino Sans W9 (font-weight 900)
 *
 * 出力:
 *   yt-thumbnail-h.png  (1280x720, YouTube Search/Browse)
 *   yt-thumbnail-v.png  (1080x1920, YouTube Shorts player)
 *   ig-reels-cover.png  (1080x1920, IG Reels)
 *   ig-feed.png         (1080x1080, IG Feed)
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
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const mmdd = enDate(date);

  await renderSvg(path.join(dir, "yt-thumbnail-h.png"),  youtubeHorizontal(script, mmdd), 1280, 720);
  await renderSvg(path.join(dir, "yt-thumbnail-v.png"),  youtubeVertical(script, mmdd),   1080, 1920);
  await renderSvg(path.join(dir, "ig-reels-cover.png"),  igReelsCover(script, mmdd),       1080, 1920);
  await renderSvg(path.join(dir, "ig-feed.png"),         igFeed(script, mmdd),             1080, 1080);
  await renderSvg(path.join(dir, "tiktok-cover.png"),    tiktokCover(script, mmdd),        1080, 1920);

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
function wrapOne(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
function flagImg(code: string, x: number, y: number, w: number): string {
  return `<image href="_assets/${code.toLowerCase()}.png" x="${x}" y="${y}" width="${w}" height="${(w * 0.66).toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
}

/** YouTube horizontal 1280x720 */
function youtubeHorizontal(s: Script, mmdd: string): string {
  const codes = s.stories.map(st => st.country.code);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <rect width="1280" height="720" fill="#0A0A0A"/>

  <!-- Top accent stripe -->
  <rect x="0" y="0" width="640" height="80" fill="#E63946"/>
  <text x="40" y="62" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#FFFFFF" letter-spacing="6">${escape(mmdd)} · WORLD NEWS</text>

  <!-- Big headline -->
  <text x="40" y="240" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#FFFFFF" letter-spacing="-3">TODAY.</text>
  <text x="40" y="380" font-family="Hiragino Sans" font-weight="900"
        font-size="130" fill="#FFFFFF" letter-spacing="-3">3 STORIES.</text>
  <text x="40" y="540" font-family="Hiragino Sans" font-weight="900"
        font-size="180" fill="#F5E63B" letter-spacing="-4">60s.</text>

  <!-- Flag stack right side -->
  ${flagImg(codes[0], 920, 80,  300)}
  ${flagImg(codes[1], 920, 290, 300)}
  ${flagImg(codes[2], 920, 500, 300)}

  <!-- Brand footer -->
  <text x="40" y="690" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#7A7A7A" letter-spacing="4">DAILY WORLD 60 · @60dailyworld</text>
</svg>`;
}

/** YouTube Shorts vertical 1080x1920 */
function youtubeVertical(s: Script, mmdd: string): string {
  const codes = s.stories.map(st => st.country.code);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>

  <!-- Top dateline -->
  <rect x="60" y="280" width="500" height="86" fill="#F5E63B"/>
  <text x="80" y="344" font-family="Hiragino Sans" font-weight="900"
        font-size="48" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>

  <!-- Hero text -->
  <text x="60" y="540" font-family="Hiragino Sans" font-weight="900"
        font-size="150" fill="#FFFFFF" letter-spacing="-3">TODAY'S</text>
  <text x="60" y="700" font-family="Hiragino Sans" font-weight="900"
        font-size="150" fill="#FFFFFF" letter-spacing="-3">3 STORIES</text>

  <!-- Hero number -->
  <text x="40" y="1180" font-family="Hiragino Sans" font-weight="900"
        font-size="540" fill="#E63946" letter-spacing="-8">60s</text>

  <!-- 3 flags row -->
  ${flagImg(codes[0], 75,  1400, 290)}
  ${flagImg(codes[1], 395, 1400, 290)}
  ${flagImg(codes[2], 715, 1400, 290)}

  <!-- Brand footer -->
  <text x="60" y="1740" font-family="Hiragino Sans" font-weight="900"
        font-size="64" fill="#F5E63B" letter-spacing="4">DAILY WORLD 60</text>
  <text x="60" y="1800" font-family="Hiragino Sans" font-weight="600"
        font-size="36" fill="#9CA3AF" letter-spacing="2">@60dailyworld</text>
</svg>`;
}

/**
 * IG Reels cover 1080x1920.
 * Safe zones: top 210 / bottom 320 / right 84-120.
 * Hook text Y 220-720.
 */
function igReelsCover(s: Script, mmdd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0F1B3D"/>

  <!-- Top dateline (Y 220, within safe zone 210+) -->
  <rect x="60" y="220" width="450" height="80" fill="#F5E63B"/>
  <text x="80" y="282" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0A0A0A" letter-spacing="6">${escape(mmdd)} · WORLD</text>

  <!-- Hook block (Y 380-720) -->
  <text x="60" y="460" font-family="Hiragino Sans" font-weight="900"
        font-size="138" fill="#FFFFFF" letter-spacing="-2">3 STORIES.</text>
  <text x="60" y="600" font-family="Hiragino Sans" font-weight="900"
        font-size="138" fill="#F5E63B" letter-spacing="-2">60 SECONDS.</text>

  <!-- Stories list (Y 840-1480, within safe zone < 1600) -->
  ${s.stories.map((st, i) => {
    const y = 880 + i * 200;
    return `
  ${flagImg(st.country.code, 60, y - 80, 180)}
  <text x="280" y="${y - 28}" font-family="Hiragino Sans" font-weight="900"
        font-size="36" fill="#F5E63B" letter-spacing="3">${escape(st.country.code)} · ${escape(st.sourceName.toUpperCase())}</text>
  <text x="280" y="${y + 24}" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#FFFFFF" letter-spacing="-1">${escape(wrapOne(st.headline, 24))}</text>`;
  }).join("")}

  <!-- Footer (above bottom safe zone) -->
  <text x="60" y="1560" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#FFFFFF" letter-spacing="6">@60dailyworld</text>
</svg>`;
}

/** IG Feed 1080x1080 (newspaper coded) */
function igFeed(s: Script, mmdd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <rect width="1080" height="1080" fill="#F4F1EA"/>

  <!-- Newspaper top stripes -->
  <rect x="60" y="60" width="960" height="6" fill="#0A0A0A"/>
  <rect x="60" y="80" width="960" height="2" fill="#0A0A0A"/>
  <text x="60" y="150" font-family="Hiragino Sans" font-weight="600"
        font-size="32" fill="#0A0A0A" letter-spacing="8">DAILY WORLD 60 · ${escape(mmdd)} · WORLD</text>

  <!-- Hero -->
  <text x="60" y="310" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#0A0A0A" letter-spacing="-3">TODAY'S</text>
  <text x="60" y="420" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#E63946" letter-spacing="-3">3 STORIES.</text>

  <!-- Stories list -->
  ${s.stories.map((st, i) => {
    const y = 560 + i * 140;
    return `
  ${flagImg(st.country.code, 60, y - 60, 120)}
  <text x="220" y="${y - 18}" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#0A0A0A" letter-spacing="-1">${escape(wrapOne(st.headline, 28))}</text>
  <text x="220" y="${y + 28}" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#7A7A7A" letter-spacing="3">${escape(st.sourceName.toUpperCase())} · ${escape(st.country.code)}</text>`;
  }).join("")}

  <!-- Bottom signature -->
  <text x="60" y="1020" font-family="Hiragino Sans" font-weight="900"
        font-size="30" fill="#0A0A0A" letter-spacing="6">@60dailyworld</text>
  <text x="1020" y="1020" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="24" fill="#7A7A7A" letter-spacing="2">YouTube · TikTok · Instagram</text>
</svg>`;
}

/** TikTok cover 1080x1920 — bottom 200 clean for UI */
function tiktokCover(s: Script, mmdd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <rect width="1080" height="1920" fill="#0A0A0A"/>

  <!-- Pattern interrupt hook -->
  <text x="60" y="280" font-family="Hiragino Sans" font-weight="900"
        font-size="58" fill="#F5E63B" letter-spacing="8">STOP SCROLLING</text>

  <!-- Hero -->
  <text x="60" y="460" font-family="Hiragino Sans" font-weight="900"
        font-size="160" fill="#FFFFFF" letter-spacing="-3">WORLD</text>
  <text x="60" y="620" font-family="Hiragino Sans" font-weight="900"
        font-size="160" fill="#FFFFFF" letter-spacing="-3">IN 60s.</text>

  <!-- 3 story chips -->
  ${s.stories.map((st, i) => {
    const y = 870 + i * 200;
    return `
  <rect x="60" y="${y - 70}" width="960" height="160" fill="#1A1A1A" stroke="#F5E63B" stroke-width="3"/>
  ${flagImg(st.country.code, 90, y - 50, 160)}
  <text x="290" y="${y - 6}" font-family="Hiragino Sans" font-weight="900"
        font-size="40" fill="#F5E63B" letter-spacing="3">${escape(st.country.code)} · STORY ${st.index}</text>
  <text x="290" y="${y + 48}" font-family="Hiragino Sans" font-weight="900"
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
