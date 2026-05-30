import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishYoutube } from "./publishers/youtube.js";
import { publishX } from "./publishers/x.js";
import { publishInstagram } from "./publishers/instagram.js";
import { publishTikTok } from "./publishers/tiktok.js";

/**
 * 投稿パイプライン (v11): 3 ストーリーをそれぞれ 60 秒 1 動画として
 * YouTube / Instagram / TikTok に投稿。X は 3 ツイート 1 スレッド (テキストのみ)。
 *
 * 入力 (output/YYYY-MM-DD/):
 *   script-en.json / script-jp.json
 *   news-{1-3}-{code}.mp4
 *   yt-thumbnail-v-{code}.png  (Shorts player サムネ)
 *   ig-reels-cover-{code}.png
 *   tiktok-cover-{code}.png
 *
 * 出力:
 *   publish-results.json (各プラットフォーム × 各ストーリーの投稿結果)
 */

interface Story {
  index: number;
  country: { code: string; flag: string; name?: string };
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  keyword?: { word: string; definitionEn: string };
}
interface ScriptEn { date: string; stories: Story[]; }
interface ScriptJp { date: string; stories: Story[]; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);

  const scriptEn: ScriptEn = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const scriptJpRaw = await fs.readFile(path.join(dir, "script-jp.json"), "utf-8").catch(() => null);
  const scriptJp: ScriptJp | null = scriptJpRaw ? JSON.parse(scriptJpRaw) : null;

  const mmdd = date.slice(5).replace("-", "/");

  const results: Record<string, unknown> = {
    date,
    perStory: {} as Record<string, unknown>,
    x: null as unknown,
  };

  // 3 ストーリーごとに YouTube / Instagram / TikTok 投稿
  for (const story of scriptEn.stories) {
    const code = story.country.code.toLowerCase();
    const videoPath = path.join(dir, `news-${story.index}-${code}.mp4`);
    const ytThumb = path.join(dir, `yt-thumbnail-v-${code}.png`);
    const igCover = path.join(dir, `ig-reels-cover-${code}.png`);
    const ttCover = path.join(dir, `tiktok-cover-${code}.png`);

    const countryName = story.country.name ?? story.country.code;
    const ytTitle = `${countryName}: ${story.headline} | Daily World 60`;
    const ytDesc = buildYoutubeDescription(story, scriptEn.date);
    const ytTags = [
      "World News", "Daily News", "60 Seconds", "Short News",
      countryName, story.country.code, story.sourceName,
      ...(story.keyword ? [story.keyword.word] : []),
    ];

    const igCaption = buildSocialCaption(story);
    const ttCaption = buildSocialCaption(story);

    console.log(`\n[publish] === Story ${story.index} (${code}: ${countryName}) ===`);

    // 直列実行 (Cookie 競合・rate limit 対策)
    const ytRes = await publishYoutube({
      videoPath, thumbnailPath: ytThumb,
      title: ytTitle, description: ytDesc, tags: ytTags,
    });
    console.log(`[publish] ${code} YouTube:`, ytRes.ok ? "✓" : `✗ ${ytRes.error}`);

    const igRes = await publishInstagram({ videoPath, caption: igCaption });
    console.log(`[publish] ${code} Instagram:`, igRes.ok ? "✓" : `✗ ${igRes.error}`);

    const ttRes = await publishTikTok({ videoPath, caption: ttCaption });
    console.log(`[publish] ${code} TikTok:`, ttRes.ok ? "✓" : `✗ ${ttRes.error}`);

    (results.perStory as Record<string, unknown>)[code] = {
      story: story.index,
      country: countryName,
      headline: story.headline,
      youtube: ytRes,
      instagram: igRes,
      tiktok: ttRes,
    };
  }

  // X: 3 ツイート 1 スレッド (日本語、テキストのみ)
  if (scriptJp) {
    const thread = buildXThread(scriptJp, scriptEn, mmdd);
    console.log(`\n[publish] === X (${thread.length} tweets) ===`);
    const xRes = await publishX({ thread });
    console.log(`[publish] X:`, xRes.ok ? "✓" : `✗ ${xRes.error}`);
    results.x = xRes;
  }

  await fs.writeFile(
    path.join(dir, "publish-results.json"),
    JSON.stringify(results, null, 2),
    "utf-8",
  );

  console.log(`\n[publish] Done. Results → ${path.join(dir, "publish-results.json")}`);
}

function buildYoutubeDescription(story: Story, date: string): string {
  const lines = [
    `${story.headline}`,
    "",
    story.summary,
    "",
    `Source: ${story.sourceName}`,
    `${story.sourceUrl}`,
    "",
  ];
  if (story.keyword) {
    lines.push(
      `Today's English keyword: ${story.keyword.word}`,
      story.keyword.definitionEn,
      "",
    );
  }
  lines.push(
    `${date} · Daily World 60`,
    "Subscribe for daily 60-second world news from around the world.",
    "",
    "Educational summary · Fair use (US §107 / JP 著作権法32条)",
    "AI-assisted voice and video editing.",
    "",
    `#WorldNews #DailyNews #60Seconds #Shorts #${story.country.code} #${story.sourceName.replace(/\s+/g, "")}`,
  );
  return lines.join("\n");
}

function buildSocialCaption(story: Story): string {
  const cn = story.country.name ?? story.country.code;
  return [
    `${story.country.flag} ${story.headline}`,
    "",
    story.summary,
    "",
    story.keyword ? `Today's keyword: ${story.keyword.word}` : "",
    "",
    `Source: ${story.sourceName}`,
    "",
    `#WorldNews #${cn.replace(/\s+/g, "")} #DailyWorld60 #News`,
  ].filter(Boolean).join("\n");
}

function buildXThread(scriptJp: ScriptJp, scriptEn: ScriptEn, mmdd: string): string[] {
  const tweets: string[] = [];
  scriptJp.stories.forEach((jpStory, i) => {
    const enStory = scriptEn.stories[i];
    const keyword = enStory?.keyword?.word;
    const summary = jpStory.summary.length > 70 ? jpStory.summary.slice(0, 69) + "…" : jpStory.summary;
    tweets.push(
      `🌍 ${mmdd} ${i + 1}/3\n` +
      `${jpStory.country.flag} ${jpStory.headline}\n` +
      `\n` +
      `${summary}\n` +
      `\n` +
      `今日の英単語: ${keyword ?? "—"}\n` +
      `出典: ${jpStory.sourceName}\n` +
      `#DailyWorld60 #世界ニュース`,
    );
  });
  return tweets;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
