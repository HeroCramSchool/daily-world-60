import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishYoutube } from "./publishers/youtube.js";
import { publishX } from "./publishers/x.js";
import { publishInstagramGraph, hasGraphCreds } from "./publishers/instagram-graph.js";
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
  hookText?: string;
  hookPattern?: string;
  commentQuestion?: string;
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
  const dir = process.env.OUT_DIR ?? path.join("output", date);

  const scriptEn: ScriptEn = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const scriptJpRaw = await fs.readFile(path.join(dir, "script-jp.json"), "utf-8").catch(() => null);
  const scriptJp: ScriptJp | null = scriptJpRaw ? JSON.parse(scriptJpRaw) : null;

  const mmdd = date.slice(5).replace("-", "/");

  // ─── Platform skip flags ───
  const skipList = (process.env.PUBLISH_SKIP ?? "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const shouldSkip = (p: string) => skipList.includes(p);
  if (skipList.length > 0) console.log(`[publish] PUBLISH_SKIP=${skipList.join(",")}`);

  // ─── 強制再投稿フラグ (差し替え再アップ用、一回限り) ───
  // FORCE_REPUBLISH=true のときだけ重複防止(台帳/前日/当日既投稿)を無視する。
  // 既定 false なので通常運用の重複防止はそのまま維持される。
  const forceRepublish = (process.env.FORCE_REPUBLISH ?? "").toLowerCase() === "true";
  if (forceRepublish) console.log(`[publish] FORCE_REPUBLISH=true — bypassing dedup ledger + already-posted checks (one-off re-upload)`);

  // ─── YouTube 公開時刻の階段ずらし ───
  // 同時刻に複数本公開すると再生数が伸びにくいため、PUBLISH_STAGGER_MINUTES > 0 のとき
  // 2本目以降を private + publishAt の予約公開にして 1本ずつ時間を空ける。
  const staggerMin = Number(process.env.PUBLISH_STAGGER_MINUTES ?? "0") || 0;
  let ytUploadedCount = 0;
  if (staggerMin > 0) console.log(`[publish] PUBLISH_STAGGER_MINUTES=${staggerMin} — 2nd+ videos will be scheduled at ${staggerMin}-min intervals`);

  // ─── Instagram 本数キャップ (アカウント健全性: 連投スパム判定の回避) ───
  // IG_MAX_PER_RUN > 0 のとき、1 run あたりの IG 投稿をその本数で打ち切る。
  // schedule 既定は 1 (= 朝昼夜で1日3リール)。0 = 無制限。
  const igCap = Number(process.env.IG_MAX_PER_RUN ?? "0") || 0;
  let igPostedCount = 0;
  if (igCap > 0) console.log(`[publish] IG_MAX_PER_RUN=${igCap}`);

  // ─── 重複防止: 投稿済み台帳(posted-ledger.json, 直近14日) + 前日 publish-results と照合 ───
  // 台帳には実際に投稿した見出しが日付付きで蓄積される(手動投稿分も seed 可能)。
  const ledger = await loadLedger().catch(e => {
    console.warn(`[publish] ledger load failed (continuing): ${e instanceof Error ? e.message : e}`);
    return { entries: [] as LedgerEntry[], fileId: undefined as string | undefined };
  });
  const yesterdayHeadlines = await fetchYesterdayHeadlines(date).catch(e => {
    console.warn(`[publish] yesterday fetch failed (continuing): ${e instanceof Error ? e.message : e}`);
    return [];
  });
  const cutoff14 = new Date(`${date}T00:00:00Z`).getTime() - LEDGER_DAYS * 86400000;
  const ledgerRecent = ledger.entries.filter(e => {
    const t = new Date(`${e.date}T00:00:00Z`).getTime();
    return !Number.isFinite(t) || t >= cutoff14;
  });
  const newlyPosted: LedgerEntry[] = [];
  console.log(`[publish] dedup: ledger=${ledgerRecent.length} (last ${LEDGER_DAYS}d), yesterday=${yesterdayHeadlines.length}`);

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
    // 過去に投稿済み(重複)なら skip (FORCE_REPUBLISH 時は無視)
    if (!forceRepublish && isDuplicate(story.headline, story.country.code, date, ledgerRecent, yesterdayHeadlines)) {
      console.log(`[publish] SKIP story ${story.index} (${story.country.code}): duplicate of recently posted headline`);
      (results.perStory as Record<string, unknown>)[story.country.code.toLowerCase()] = {
        story: story.index,
        country: story.country.code,
        headline: story.headline,
        skipped: true,
        reason: "duplicate_recent",
      };
      continue;
    }
    const code = story.country.code.toLowerCase();
    const videoPath = path.join(dir, `news-${story.index}-${code}.mp4`);
    const ytThumb = path.join(dir, `yt-thumbnail-v-${code}.png`);
    const igCover = path.join(dir, `ig-reels-cover-${code}.png`);
    const ttCover = path.join(dir, `tiktok-cover-${code}.png`);

    const countryName = story.country.name ?? story.country.code;
    // タイトルは画面1フレーム目の hookText と完全一致させる (2026-06-27):
    //   旧「見出し全文(11-14語の受け身文)」はフィードの topic model が読む最弱の言い回し。
    //   既存の 3-6語 hookText を front-frame・最初の発話・タイトルで揃える = 初速のレバー。
    //   hookText が無い/長すぎる回のみ見出しにフォールバック。発見用ハッシュタグは2つだけ。
    const hookTitle = story.hookText?.trim();
    const titleHead = hookTitle && hookTitle.length <= 90 ? hookTitle : story.headline;
    const ytTitle = `${titleHead} #Shorts #WorldNews`;
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
      !forceRepublish && Boolean(prevStory[plat]?.ok && (prevStory[plat]?.url || prevStory[plat]?.videoId));

    // 直列実行 (Cookie 競合・rate limit 対策)
    let ytRes: unknown;
    if (shouldSkip("youtube")) {
      ytRes = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
    } else if (alreadyPosted("youtube")) {
      ytRes = { ok: true, skipped: true, reason: "already_posted_today", ...prevStory.youtube };
    } else {
      const publishAt = staggerMin > 0 && ytUploadedCount > 0
        ? new Date(Date.now() + ytUploadedCount * staggerMin * 60000).toISOString()
        : undefined;
      if (publishAt) console.log(`[publish] ${code} YouTube: scheduled publish at ${publishAt}`);
      ytRes = await publishYoutube({
        videoPath, thumbnailPath: ytThumb,
        title: ytTitle, description: ytDesc, tags: ytTags,
        ...(publishAt ? { publishAt } : {}),
      });
      if (isOk(ytRes)) {
        ytUploadedCount++;
        if (publishAt) (ytRes as Record<string, unknown>).publishAt = publishAt;
      }
    }
    console.log(`[publish] ${code} YouTube:`, isOk(ytRes) ? "✓" : isSkipped(ytRes) ? "⏭" : `✗ ${getErr(ytRes)}`);
    if (isOk(ytRes) && !isSkipped(ytRes)) newlyPosted.push({ date, code, headline: story.headline });

    let igRes: unknown;
    if (shouldSkip("instagram")) {
      igRes = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
    } else if (alreadyPosted("instagram")) {
      igRes = { ok: true, skipped: true, reason: "already_posted_today", ...prevStory.instagram };
    } else if (igCap > 0 && igPostedCount >= igCap) {
      igRes = { ok: false, skipped: true, reason: "ig_per_run_cap" };
    } else if (!hasGraphCreds()) {
      // cookie/Playwright 経路は CI から実掲載されない偽陽性が確認されたため使わない。
      // Graph API クレデンシャル (IG_GRAPH_ACCESS_TOKEN / IG_GRAPH_USER_ID) が入るまではスキップ。
      igRes = { ok: false, skipped: true, reason: "no_ig_graph_creds" };
    } else {
      igRes = await publishInstagramGraph({ videoPath, caption: igCaption });
      if (isOk(igRes)) igPostedCount++;
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
      // フック文型の成績集計用 (週次で Stayed to watch と突き合わせる)
      ...(story.hookPattern ? { hookPattern: story.hookPattern } : {}),
      ...(story.hookText ? { hookText: story.hookText } : {}),
      youtube: ytRes,
      instagram: igRes,
      tiktok: ttRes,
    };
  }

  // X: 3 ツイート 1 スレッド (日本語、テキストのみ)
  if (shouldSkip("x")) {
    console.log(`[publish] X: skipped (PUBLISH_SKIP)`);
    results.x = { ok: false, skipped: true, reason: "PUBLISH_SKIP" };
  } else if (!forceRepublish && prevResults.x?.ok) {
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

  // ─── 投稿済み台帳に今回分を追記 (best-effort、次バッチ/翌日の重複防止用) ───
  if (newlyPosted.length > 0) {
    await saveLedger(ledger.fileId, ledger.entries, newlyPosted, date)
      .catch(e => console.warn(`[publish] ledger save failed: ${e instanceof Error ? e.message : e}`));
  }
}

function buildYoutubeDescription(story: Story, date: string): string {
  const lines = [
    `${story.headline}`,
    // コメント質問は折りたたみプレビューに見える上部に置く (コメント=強いエンゲージメントsignal・2026-06-27)
    ...(story.commentQuestion ? ["", `💬 ${story.commentQuestion}`] : []),
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
    // 宛先指定シェア CTA (ダークソーシャル/DM転送向け)
    "📩 Send this to a friend who's learning English.",
    "",
    "Educational summary for general information only · Fair use (US §107 / JP 著作権法32条)",
    "Original reporting belongs to the publisher linked above. Please verify details with the original source.",
    "Not affiliated with any government or publisher. AI-assisted voice and video editing. Images: Wikimedia Commons / agency file photos.",
    "",
    // ハッシュタグは詰め込まない (3-5が安全圏。6+は弱シグナル/無視され得る・2026-06-27)。
    `#Shorts #WorldNews #News #${story.country.code}`,
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
  const candidateNames = [`run-results-${y}.json`, `publish-results-${y}.json`];
  const r = await drive.files.list({
    q: `'${folderId}' in parents and (${candidateNames
      .map((n) => `name = '${n}'`)
      .join(" or ")}) and trashed = false`,
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

// 重複判定: (1) 国問わず強いテキスト一致(>=0.45) (2) 同一国×中程度一致(>=0.3, 直近3日)
//   → 継続ニュース(同じ国の同じ出来事)の言い換えも捕捉する
function isDuplicate(headline: string, code: string, date: string, ledgerRecent: LedgerEntry[], yesterdayHeadlines: string[]): boolean {
  const cur = normalize(headline);
  for (const h of [...ledgerRecent.map(e => e.headline), ...yesterdayHeadlines]) {
    if (jaccard(cur, normalize(h)) >= 0.45) return true;
  }
  const cutoff3 = new Date(`${date}T00:00:00Z`).getTime() - 3 * 86400000;
  for (const e of ledgerRecent) {
    if ((e.code ?? "").toLowerCase() !== code.toLowerCase()) continue;
    const t = new Date(`${e.date}T00:00:00Z`).getTime();
    if (Number.isFinite(t) && t < cutoff3) continue;
    if (jaccard(cur, normalize(e.headline)) >= 0.3) return true;
  }
  return false;
}

// ─── 投稿済み台帳 (posted-ledger.json): 実際に投稿した見出しを永続化し、
//     翌日・別バッチ・手動投稿分も含めて重複を防ぐ ───
const LEDGER_NAME = "posted-ledger.json";
const LEDGER_DAYS = 14;
interface LedgerEntry { date: string; code: string; headline: string; }

async function loadLedger(): Promise<{ entries: LedgerEntry[]; fileId?: string }> {
  const folderName = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, folderName));
  if (!folderId) return { entries: [] };
  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = '${LEDGER_NAME}' and trashed = false`,
    fields: "files(id, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 1,
  });
  const f = r.data.files?.[0];
  if (!f?.id) return { entries: [] };
  try {
    const res = await drive.files.get({ fileId: f.id, alt: "media" }, { responseType: "text" });
    const parsed = JSON.parse(res.data as unknown as string);
    return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [], fileId: f.id };
  } catch {
    return { entries: [], fileId: f.id };
  }
}

async function saveLedger(fileId: string | undefined, existing: LedgerEntry[], added: LedgerEntry[], date: string): Promise<void> {
  const folderName = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, folderName));
  if (!folderId) return;
  // 直近 LEDGER_DAYS*4 日より古いエントリは剪定 (ファイル肥大化防止)
  const cutoff = new Date(`${date}T00:00:00Z`).getTime() - LEDGER_DAYS * 4 * 86400000;
  const merged = [...existing, ...added].filter(e => {
    const t = new Date(`${e.date}T00:00:00Z`).getTime();
    return !Number.isFinite(t) || t >= cutoff;
  });
  const body = JSON.stringify({ entries: merged }, null, 2);
  if (fileId) {
    await drive.files.update({ fileId, media: { mimeType: "application/json", body } });
  } else {
    await drive.files.create({
      requestBody: { name: LEDGER_NAME, parents: [folderId] },
      media: { mimeType: "application/json", body },
    });
  }
  console.log(`[publish] ledger updated: +${added.length} (total ${merged.length})`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
