import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishInstagram } from "./publishers/instagram.js";

/**
 * One-off: publish the 3 background videos to Instagram from the local mac
 * (residential IP). Uses the videos downloaded from the CI artifact.
 * Run: VIDEO_DIR=/tmp/dw60-art2 npx tsx scripts/publish-ig-local.ts
 */

const STORIES = [
  {
    code: "lb", flag: "🇱🇧", file: "news-1-lb.mp4",
    headline: "Israel pushes deeper into Lebanon as death toll rises",
    summary: "Israel's army is moving deeper into southern Lebanon. Health officials say more than 3,400 people have died since March. The US and Iran are still trying to reach a peace deal.",
    source: "Al Jazeera", country: "Lebanon",
  },
  {
    code: "co", flag: "🇨🇴", file: "news-2-co.mp4",
    headline: "Colombia holds presidential vote today, runoff likely",
    summary: "Colombians went to the polls Sunday in a presidential election. Leftist Iván Cepeda leads in polls, but may not win outright. A runoff is expected on June 21.",
    source: "Rio Times Online", country: "Colombia",
  },
  {
    code: "rw", flag: "🇷🇼", file: "news-3-rw.mp4",
    headline: "Rwanda signs nuclear deal with Russia",
    summary: "Rwanda signed a nuclear cooperation agreement with Russia, covering medicine and clean energy. Analysts say this signals Africa is looking for new global partners.",
    source: "Africa Press", country: "Rwanda",
  },
];

function caption(s: typeof STORIES[number]): string {
  return [
    `${s.flag} ${s.headline}`,
    "",
    s.summary,
    "",
    `Today's keyword: ceasefire`,
    "",
    `Source: ${s.source}`,
    "",
    `#WorldNews #${s.country.replace(/\s+/g, "")} #DailyWorld60 #News`,
  ].join("\n");
}

async function main() {
  const dir = process.env.VIDEO_DIR ?? "/tmp/dw60-art2";
  const b64 = (await fs.readFile(
    path.join(process.env.HOME ?? "", ".config", "dailyworld60", "instagram-cookies.b64"),
    "utf-8",
  )).trim();
  process.env.INSTAGRAM_COOKIES_B64 = b64;

  const results: Record<string, unknown> = {};
  for (const s of STORIES) {
    const videoPath = path.join(dir, s.file);
    console.log(`\n=== IG ${s.code}: ${s.headline} ===`);
    const r = await publishInstagram({ videoPath, caption: caption(s) });
    console.log(`[ig] ${s.code}:`, r.ok ? `✓ ${r.url}` : `✗ ${r.error}`);
    results[s.code] = r;
    await new Promise(res => setTimeout(res, 8000));
  }
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
