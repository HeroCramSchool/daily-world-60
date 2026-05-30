import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishYoutube } from "./publishers/youtube.js";
import { publishX } from "./publishers/x.js";
import { publishInstagram } from "./publishers/instagram.js";
import { publishTikTok } from "./publishers/tiktok.js";
import { Script } from "../domain/script/Script.js";

interface Stories {
  index: number;
  country: { code: string; flag: string };
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);

  const scriptEn = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const scriptJpRaw = await fs
    .readFile(path.join(dir, "script-jp.json"), "utf-8")
    .catch(() => null);
  const scriptJp = scriptJpRaw ? JSON.parse(scriptJpRaw) : null;

  const videoPath = path.join(dir, "final.mp4");
  const thumbPath = path.join(dir, "thumbnail.png");

  // Build YouTube metadata
  const ytTitle = `Daily World 60 — ${date} | World News`;
  const ytDesc = buildYoutubeDescription(scriptEn);
  const ytTags = buildTags(scriptEn);

  const captionEn = buildSocialCaption(scriptEn);

  console.log("[publish] starting 4 publishers in parallel...");

  const [ytRes, xRes, igRes, ttRes] = await Promise.all([
    publishYoutube({
      videoPath, thumbnailPath: thumbPath,
      title: ytTitle, description: ytDesc, tags: ytTags,
    }),
    scriptJp
      ? publishX({ thread: Script.toXThread(scriptJp) })
      : Promise.resolve({ ok: false, error: "no jp script" }),
    publishInstagram({ videoPath, caption: captionEn }),
    publishTikTok({ videoPath, caption: captionEn }),
  ]);

  const results = {
    date,
    youtube: ytRes,
    x: xRes,
    instagram: igRes,
    tiktok: ttRes,
  };

  console.log(JSON.stringify(results, null, 2));

  await fs.writeFile(
    path.join(dir, "publish-results.json"),
    JSON.stringify(results, null, 2),
    "utf-8",
  );
}

function buildYoutubeDescription(s: { stories: Stories[]; todaysWord: { word: string; definitionEn: string } }): string {
  const lines: string[] = [
    "Today's top 3 world stories in 60 seconds.",
    "",
    "Stories:",
    ...s.stories.map(st => `${st.index}. ${st.country.flag} ${st.headline} (${st.sourceName})`),
    "",
    "Sources:",
    ...s.stories.map(st => `- ${st.sourceName}: ${st.sourceUrl}`),
    "",
    `Today's word: ${s.todaysWord.word} — ${s.todaysWord.definitionEn}`,
    "",
    "Follow for daily 60-second world news.",
    "",
    "#WorldNews #DailyNews #60Seconds #Shorts #News",
  ];
  return lines.join("\n");
}

function buildTags(s: { stories: Stories[] }): string[] {
  return [
    "World News",
    "Daily News",
    "60 Seconds",
    "Short News",
    ...s.stories.map(st => st.country.code),
  ];
}

function buildSocialCaption(s: { stories: Stories[]; todaysWord: { word: string }; close?: string }): string {
  const headlines = s.stories
    .map(st => `${st.country.flag} ${st.headline}`)
    .join(" / ");
  return `${headlines}\n\nToday's word: ${s.todaysWord.word}\n\n#WorldNews #DailyNews #60Seconds`;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
