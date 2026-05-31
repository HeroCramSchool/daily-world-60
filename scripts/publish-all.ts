import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishYoutube } from "./publishers/youtube.js";
import { publishX } from "./publishers/x.js";
import { publishInstagram } from "./publishers/instagram.js";
import { publishTikTok } from "./publishers/tiktok.js";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";

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
interface JpThreadTweet { tweetIndex?: number; text: string; }
interface ScriptJp {
  date: string;
  stories: Story[];
  thread?: JpThreadTweet[]; // Routine v2 が直接ツイート配列を入れる場合
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);

  const scriptEn: ScriptEn = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const scriptJpRaw = await fs.readFile(path.join(dir, "script-jp.json"), "utf-8").catch(() => null);
  const scriptJp: ScriptJp | null = scriptJpRaw ? JSON.parse(scriptJpRaw) : null;

  const mmdd = date.slice(5).replace("-", "/");

  // ─── Platform skip flags ───
  const skipList = (process.env.PUBLISH_SKIP ?? "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const shouldSkip = (p: string) => skipList.includes(p);
  if (skipList.length > 0) console.log(`[publish] PUBLISH_SKIP=${skipList.join(",")}`);

  // ─── 前日重複チェック (Drive 経由) ───
  const yesterdayHeadlines = await fetchYesterdayHeadlines(date).catch(e => {
    console.warn(`[publish] yesterday fetch failed (continuing): ${e instanceof Error ? e.message : e}`);
    return [];
  });
  if (yesterdayHeadlines.length > 0) {
    console.log(`[publish] yesterday had ${yesterdayHeadlines.length} stories, checking dup...`);
  }

  // ─── 当日既投稿チェック (再 trigger 時の重複防止) ───
  interface PrevResults { perStory?: Record<string, Record<string, { ok?: boolean; url?: string; videoId?: string }>>; x?: { ok?: boolean }; }
  let prevResults: PrevResults = {};
  try {
    prevResults = JSON.parse(await fs.readFile(path.join(dir, "publish-results.json"), "utf-8"));
    console.log(`[publish] previous publish-results.json found, skipping already-posted entries`);
  } catch {
    // first run for this date
  }

  const results: Record<string, unknown> = {
    date,
    perStory: {} as Record<string, unknown>,
    x: null as unknown,
  };

  // 3 ストーリーごとに YouTube / Instagram / TikTok 投稿
  for (const story of scriptEn.stories) {
    // 前日重複なら skip
    if (isDuplicateOfYesterday(story.headline, yesterdayHeadlines)) {
      console.log(`[publish] SKIP story ${story.index} (${story.country.code}): duplicate of yesterday headline`);
      (results.perStory as Record<string, unknown>)[story.country.code.toLowerCase()] = {
        story: story.index,
        country: story.country.code,
        headline: story.headline,
        skipped: true,
        reason: "duplicate_of_yesterday",
      };
      continue;
    }
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
    // 各 publisher 起動前に warm-up wait (初回 Chrome 起動オーバーヘッド対策)
    await new Promise(r => setTimeout(r, 5000));

    const prevStory = prevResults.perStory?.[code] ?? {};
    const alreadyPosted = (plat: string): boolean =>
      Boolean(prevStory[plat]?.ok && (prevStory[plat]?.url || prevStory[plat]?.videoId));

    // 直列実行 (Cookie 競合・rate limit 対策)
    let ytRes: unknown;
    if (shouldSkip("youtube")) {
      ytRes = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
    } else if (alreadyPosted("youtube")) {
      ytRes = { ok: true, skipped: true, reason: "already_posted_today", ...prevStory.youtube };
    } else {
      ytRes = await publishYoutube({
        videoPath, thumbnailPath: ytThumb,
        title: ytTitle, description: ytDesc, tags: ytTags,
      });
    }
    console.log(`[publish] ${code} YouTube:`, isOk(ytRes) ? "✓" : isSkipped(ytRes) ? "⏭" : `✗ ${getErr(ytRes)}`);

    let igRes: unknown;
    if (shouldSkip("instagram")) {
      igRes = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
    } else if (alreadyPosted("instagram")) {
      igRes = { ok: true, skipped: true, reason: "already_posted_today", ...prevStory.instagram };
    } else {
      igRes = await publishInstagram({ videoPath, caption: igCaption });
    }
    console.log(`[publish] ${code} Instagram:`, isOk(igRes) ? "✓" : isSkipped(igRes) ? "⏭" : `✗ ${getErr(igRes)}`);

    let ttRes: unknown;
    if (shouldSkip("tiktok")) {
      ttRes = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
    } else if (alreadyPosted("tiktok")) {
      ttRes = { ok: true, skipped: true, reason: "already_posted_today", ...prevStory.tiktok };
    } else {
      ttRes = await publishTikTok({ videoPath, caption: ttCaption });
    }
    console.log(`[publish] ${code} TikTok:`, isOk(ttRes) ? "✓" : isSkipped(ttRes) ? "⏭" : `✗ ${getErr(ttRes)}`);

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
  if (shouldSkip("x")) {
    console.log(`[publish] X: skipped (PUBLISH_SKIP)`);
    results.x = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
  } else if (prevResults.x?.ok) {
    console.log(`[publish] X: already posted today, skipping`);
    results.x = { ok: true, skipped: true, reason: "already_posted_today", ...prevResults.x };
  } else if (scriptJp) {
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
  // Routine v2 出力は scriptJp.thread に直接ツイート配列。
  // 各 story tweet (index 1-3) に sourceUrl を末尾 append。
  // tweet index 0 = intro, 1-3 = stories, 4+ = today's word / cta
  if (Array.isArray(scriptJp.thread) && scriptJp.thread.length > 0) {
    return scriptJp.thread.map((t, i) => {
      let text = t.text;
      const storyIdx = i - 1; // tweet 1-3 → story 0-2
      const story = scriptEn.stories[storyIdx];
      if (storyIdx >= 0 && storyIdx < scriptEn.stories.length && story?.sourceUrl) {
        // X の URL は t.co で 23 字相当固定。append しても CJK 多い tweet は 140 内に収まる
        text = text + "\n" + story.sourceUrl;
      }
      return text;
    }).filter(Boolean);
  }
  // フォールバック: stories から組み立て (古いフォーマット用)
  const tweets: string[] = [];
  if (!Array.isArray(scriptJp.stories) || scriptJp.stories.length === 0) {
    console.warn("[publish] scriptJp has neither thread nor stories — empty X thread");
    return tweets;
  }
  scriptJp.stories.forEach((jpStory, i) => {
    const enStory = scriptEn.stories[i];
    const keyword = enStory?.keyword?.word;
    const summary = jpStory.summary.length > 60 ? jpStory.summary.slice(0, 59) + "…" : jpStory.summary;
    tweets.push(
      `🌍 ${mmdd} ${i + 1}/3\n` +
      `${jpStory.country.flag} ${jpStory.headline}\n` +
      `\n` +
      `${summary}\n` +
      `\n` +
      `今日の英単語: ${keyword ?? "—"}\n` +
      `出典: ${jpStory.sourceName}\n` +
      (enStory?.sourceUrl ? `${enStory.sourceUrl}\n` : "") +
      `#DailyWorld60`,
    );
  });
  return tweets;
}

// ─── Result helpers ───
function isOk(r: unknown): boolean {
  return typeof r === "object" && r !== null && "ok" in r && (r as { ok?: boolean }).ok === true;
}
function isSkipped(r: unknown): boolean {
  return typeof r === "object" && r !== null && "skipped" in r && (r as { skipped?: boolean }).skipped === true;
}
function getErr(r: unknown): string {
  if (typeof r === "object" && r !== null && "error" in r) {
    return String((r as { error?: unknown }).error ?? "").slice(0, 120);
  }
  return "";
}

// ─── Yesterday duplication check ───
async function fetchYesterdayHeadlines(date: string): Promise<string[]> {
  const t = new Date(`${date}T00:00:00Z`);
  const y = new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
  const folderName = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, folderName));
  if (!folderId) return [];
  const fileName = `publish-results-${y}.json`;
  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 5,
  });
  const headlines: string[] = [];
  for (const f of r.data.files ?? []) {
    try {
      const res = await drive.files.get({ fileId: f.id!, alt: "media" }, { responseType: "text" });
      const parsed = JSON.parse(res.data as unknown as string);
      // 既出フォーマット (publish-all.ts 出力) と Routine フォーマット 両対応
      if (parsed.perStory && typeof parsed.perStory === "object") {
        for (const v of Object.values(parsed.perStory)) {
          const h = (v as { headline?: string }).headline;
          if (h) headlines.push(h);
        }
      } else if (parsed.scriptEn?.stories) {
        for (const s of parsed.scriptEn.stories) {
          if (s.headline) headlines.push(s.headline);
        }
      } else if (parsed.stages?.curate?.selected) {
        for (const s of parsed.stages.curate.selected) {
          if (s.headline) headlines.push(s.headline);
        }
      }
    } catch { /* skip */ }
  }
  return headlines;
}

function normalize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return inter / uni;
}

function isDuplicateOfYesterday(headline: string, yesterdayHeadlines: string[]): boolean {
  const cur = normalize(headline);
  for (const prev of yesterdayHeadlines) {
    if (jaccard(cur, normalize(prev)) >= 0.5) return true;
  }
  return false;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
