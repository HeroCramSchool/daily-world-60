import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";
import {
  CHANNEL_ID, TRACK_DAYS, type History, type VideoStat,
  loadHistory, saveHistory, localFile, fetchRssStats, fetchWatchPageViews, ageHours,
} from "./lib/stats.js";
import type { drive_v3 } from "googleapis";

/**
 * 夜間の視聴数スナップショット収集 (stats.yml から毎日実行)。
 * 1. チャンネル RSS (直近15本・認証不要) から視聴数を取り stats-history.json に追記
 * 2. RSS から溢れた30日以内の追跡中動画は watch ページから best-effort で補完
 * 3. run-results-{date}.json (Drive) と videoId で突き合わせて code/hookPattern 等を付与
 */

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
const WATCH_FALLBACK_DAYS = 14;

async function main() {
  const now = Date.now();
  let drive: drive_v3.Drive | undefined;
  let folderId: string | undefined;
  if (!localFile()) {
    drive = await driveClient();
    folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
    if (!folderId) throw new Error(`Drive folder "${FOLDER_NAME}" not found`);
  }

  const { history, fileId } = await loadHistory(drive, folderId);
  const nVideosBefore = Object.keys(history.videos).length;

  // ── 1. RSS スナップショット (一時障害では落とさず watch ページ側だけでも収集) ──
  let rss: Awaited<ReturnType<typeof fetchRssStats>> = [];
  try {
    rss = await fetchRssStats(CHANNEL_ID);
    console.log(`[stats] RSS: ${rss.length} entries`);
  } catch (e) {
    console.warn(`[stats] RSS failed (continuing with watch-page fallback only): ${e}`);
  }
  const nowIso = new Date(now).toISOString();
  for (const e of rss) {
    const v: VideoStat = history.videos[e.videoId] ?? {
      videoId: e.videoId, title: e.title, publishedAt: e.publishedAt, snapshots: [],
    };
    v.title = e.title;
    v.publishedAt = e.publishedAt;
    v.snapshots.push({ t: nowIso, views: e.views });
    history.videos[e.videoId] = v;
  }
  // 中間保存: 後段 (watch ページ/enrich) が落ちても RSS 分は残す
  let historyFileId = fileId;
  if (rss.length) historyFileId = (await saveHistory(history, drive, folderId, historyFileId)) ?? historyFileId;

  // ── 2. RSS 窓から溢れた追跡中動画を watch ページで補完 ──
  // 48h比較に効くのは若い動画なので窓は14日で十分。1.5s/本 + fetch で
  // 定常時 (6本/日) も job timeout 内に収まるよう最大60本に制限。
  const inRss = new Set(rss.map(e => e.videoId));
  const stale = Object.values(history.videos)
    .filter(v => !inRss.has(v.videoId) && ageHours(v, now) <= WATCH_FALLBACK_DAYS * 24)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 60);
  for (const v of stale) {
    const views = await fetchWatchPageViews(v.videoId);
    if (views !== undefined) {
      v.snapshots.push({ t: nowIso, views });
      console.log(`[stats] watch-page: ${v.videoId} views=${views}`);
    } else {
      console.warn(`[stats] watch-page: ${v.videoId} failed (skipped)`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── 3. posted-ledger.json 突き合わせでメタデータ付与 (Drive がある時のみ) ──
  if (drive && folderId) {
    await enrichFromLedger(drive, folderId, history, now);
  } else {
    console.log(`[stats] STATS_LOCAL_FILE mode: skipping ledger enrichment`);
  }

  // ── 4. スナップショット上限 (動画あたり 120 = 日次で4ヶ月分) ──
  for (const v of Object.values(history.videos)) {
    if (v.snapshots.length > 120) v.snapshots = v.snapshots.slice(-120);
  }

  await saveHistory(history, drive, folderId, historyFileId);
  console.log(`[stats] saved: ${Object.keys(history.videos).length} videos tracked (${nVideosBefore} before)`);
}

async function enrichFromLedger(drive: drive_v3.Drive, folderId: string, history: History, now: number): Promise<void> {
  // run-results-*.json は SA の storage quota 制限 (新規作成不可) で Drive に存在しない。
  // 代わりに publish-all.ts が毎回 update する posted-ledger.json (2026-07-20 から
  // videoId/hookPattern/hookText 入り) を唯一のメタデータソースにする。
  const missing = Object.values(history.videos).filter(v =>
    (!v.code || !v.headline) && ageHours(v, now) <= TRACK_DAYS * 24,
  );
  if (!missing.length) return;

  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = 'posted-ledger.json' and trashed = false`,
    fields: "files(id)",
    orderBy: "modifiedTime desc",
    pageSize: 1,
  });
  const id = r.data.files?.[0]?.id;
  if (!id) {
    console.warn(`[stats] enrich: posted-ledger.json not found`);
    return;
  }
  let entries: Array<{ date?: string; code?: string; headline?: string; videoId?: string; hookPattern?: string; hookText?: string }> = [];
  try {
    const res = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "text" });
    const parsed = JSON.parse(res.data as unknown as string);
    if (Array.isArray(parsed?.entries)) entries = parsed.entries;
  } catch {
    console.warn(`[stats] enrich: failed to parse posted-ledger.json`);
    return;
  }

  const byVideoId = new Map(entries.filter(e => e.videoId).map(e => [e.videoId!, e]));
  let enriched = 0;
  for (const v of missing) {
    const meta = byVideoId.get(v.videoId);
    if (!meta) continue;
    v.code = meta.code ?? v.code;
    v.headline = meta.headline ?? v.headline;
    v.hookPattern = meta.hookPattern ?? v.hookPattern;
    v.hookText = meta.hookText ?? v.hookText;
    v.scriptDate = meta.date ?? v.scriptDate;
    enriched++;
  }
  console.log(`[stats] enrich: ${enriched}/${missing.length} matched from ledger (${byVideoId.size} entries with videoId)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
