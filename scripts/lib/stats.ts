import * as fs from "node:fs/promises";
import type { drive_v3 } from "googleapis";

/**
 * 勝ちパターン学習ループの共有部品。
 * stats-history.json (Drive) = 動画ごとの視聴数スナップショット時系列。
 * 公開視聴数は 2025/3/31 以降 any-play カウントで水増しされているため、
 * 絶対値ではなく同チャンネル内の相対比較 (48h時点コホート比) にのみ使う。
 */

export const HISTORY_NAME = "stats-history.json";
export const CHANNEL_ID = process.env.YT_CHANNEL_ID ?? "UCDRss308_F5cXUftvHLhkBA";
export const TRACK_DAYS = 30;

export type Snapshot = { t: string; views: number };

export type VideoStat = {
  videoId: string;
  title: string;
  publishedAt: string;
  code?: string;
  headline?: string;
  hookPattern?: string;
  hookText?: string;
  scriptDate?: string;
  snapshots: Snapshot[];
};

export type History = { updatedAt: string; videos: Record<string, VideoStat> };

export function emptyHistory(): History {
  return { updatedAt: new Date().toISOString(), videos: {} };
}

/** STATS_LOCAL_FILE 指定時は Drive を使わずローカルで読み書き (オフラインテスト用)。 */
export function localFile(): string | undefined {
  return process.env.STATS_LOCAL_FILE?.trim() || undefined;
}

export async function loadHistory(drive?: drive_v3.Drive, folderId?: string): Promise<{ history: History; fileId?: string }> {
  const local = localFile();
  if (local) {
    try {
      return { history: JSON.parse(await fs.readFile(local, "utf-8")) };
    } catch {
      return { history: emptyHistory() };
    }
  }
  if (!drive || !folderId) throw new Error("loadHistory: drive/folderId required without STATS_LOCAL_FILE");
  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = '${HISTORY_NAME}' and trashed = false`,
    fields: "files(id)",
    orderBy: "modifiedTime desc",
    pageSize: 1,
  });
  const fileId = r.data.files?.[0]?.id ?? undefined;
  if (!fileId) return { history: emptyHistory() };
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
  try {
    const parsed = JSON.parse(res.data as unknown as string) as History;
    if (parsed && typeof parsed.videos === "object") return { history: parsed, fileId };
  } catch {
    console.warn(`[stats] ${HISTORY_NAME} is corrupted JSON — starting fresh (will overwrite in place)`);
  }
  return { history: emptyHistory(), fileId };
}

/** 保存先 fileId を返す (新規作成時は作成された id)。中間保存→最終保存で二重作成しないため。 */
export async function saveHistory(history: History, drive?: drive_v3.Drive, folderId?: string, fileId?: string): Promise<string | undefined> {
  history.updatedAt = new Date().toISOString();
  const body = JSON.stringify(history, null, 1);
  const local = localFile();
  if (local) {
    await fs.writeFile(local, body, "utf-8");
    return undefined;
  }
  if (!drive || !folderId) throw new Error("saveHistory: drive/folderId required without STATS_LOCAL_FILE");
  if (fileId) {
    await drive.files.update({ fileId, media: { mimeType: "application/json", body } });
    return fileId;
  }
  // 注意: WIF の SA は My Drive に新規ファイルを作れない (storage quota エラー)。
  // stats-history.json / winning-patterns.md / stats-report.md はオーナーが一度
  // 作成済み (2026-07-20) なので、通常ここには到達しない。
  try {
    const created = await drive.files.create({
      requestBody: { name: HISTORY_NAME, parents: [folderId] },
      media: { mimeType: "application/json", body },
      fields: "id",
    });
    return created.data.id ?? undefined;
  } catch (e) {
    throw new Error(`${HISTORY_NAME} create failed — service accounts cannot own new My Drive files; create it once as the folder owner. (${e})`);
  }
}

/** Drive のテキストファイルを name で上書き保存 (無ければ作成)。レポート出力用。 */
export async function upsertTextFile(drive: drive_v3.Drive, folderId: string, name: string, content: string, mimeType = "text/markdown"): Promise<void> {
  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = '${name}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  const fileId = r.data.files?.[0]?.id;
  if (fileId) {
    await drive.files.update({ fileId, media: { mimeType, body: content } });
    return;
  }
  try {
    await drive.files.create({ requestBody: { name, parents: [folderId] }, media: { mimeType, body: content } });
  } catch (e) {
    throw new Error(`${name} create failed — service accounts cannot own new My Drive files; create it once as the folder owner. (${e})`);
  }
}

export function ageHours(v: VideoStat, at: string | number): number {
  const t = typeof at === "number" ? at : new Date(at).getTime();
  return (t - new Date(v.publishedAt).getTime()) / 3600000;
}

/**
 * 公開から targetHours 時点の視聴数 (両側スナップショットがあれば線形補間)。
 * 片側しか無い場合は ±25% の時刻ずれまで近似値として許容し、それ以上
 * (例: 追跡開始のかなり後に初捕捉) は undefined = コホートから除外。
 * 視聴数は単調増加のため after 側を広く許すと過大評価で勝者判定が歪む。
 */
export function viewsAt(v: VideoStat, targetHours: number): number | undefined {
  const snaps = [...v.snapshots].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  if (!snaps.length) return undefined;
  let before: Snapshot | undefined;
  let after: Snapshot | undefined;
  for (const s of snaps) {
    const h = ageHours(v, s.t);
    if (h <= targetHours) before = s;
    else { after = s; break; }
  }
  if (before && after) {
    const hb = ageHours(v, before.t);
    const ha = ageHours(v, after.t);
    if (ha === hb) return after.views;
    const f = (targetHours - hb) / (ha - hb);
    return Math.round(before.views + (after.views - before.views) * f);
  }
  if (before && ageHours(v, before.t) >= targetHours * 0.75) return before.views;
  if (after && ageHours(v, after.t) <= targetHours * 1.25) return after.views;
  return undefined;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g, m => ENTITIES[m]);
}

export type RssEntry = { videoId: string; title: string; publishedAt: string; views: number };

/** チャンネル RSS (直近〜15本) から videoId/タイトル/公開時刻/視聴数を取る。認証不要。 */
export async function fetchRssStats(channelId: string): Promise<RssEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const entries: RssEntry[] = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = block.match(/<title>([^<]*)<\/title>/)?.[1];
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1];
    const views = block.match(/<media:statistics views="(\d+)"/)?.[1];
    if (videoId && title && publishedAt && views !== undefined) {
      entries.push({ videoId, title: decodeEntities(title), publishedAt, views: Number(views) });
    }
  }
  return entries;
}

/** RSS 窓 (15本) から溢れた追跡中動画の視聴数を watch ページから拾う (best-effort)。 */
export async function fetchWatchPageViews(videoId: string): Promise<number | undefined> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", cookie: "CONSENT=YES+1" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const m = html.match(/"viewCount":"(\d+)"/);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}
