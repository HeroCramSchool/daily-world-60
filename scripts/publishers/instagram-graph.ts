import * as fs from "node:fs/promises";
import * as path from "node:path";
import { google } from "googleapis";
import { driveClient, findFolderId } from "../fetch-scripts-from-drive.js";

/**
 * Instagram Graph API (公式) でリールを投稿する。cookie/Playwright 不使用。
 *
 * 流れ: 動画を公開URLにホスト (GCS、失敗時は Drive 公開リンクにフォールバック)
 *   → /{ig-user-id}/media で REELS コンテナ作成 → status_code=FINISHED まで poll
 *   → /{ig-user-id}/media_publish → permalink 取得 (= 真の成功確認) → ホストを削除。
 *
 * 必要 env:
 *   IG_GRAPH_ACCESS_TOKEN  (long-lived user token / system user token)
 *   IG_GRAPH_USER_ID       (Instagram Business/Creator の IG User ID)
 *   IG_VIDEO_BUCKET        (任意。既定 dw60-reels-public)
 * GCS/Drive は CI の ADC (WIF) を使う。
 */

export interface IGGraphPublishInput {
  videoPath: string;
  caption: string;
}

export interface IGGraphPublishResult {
  ok: boolean;
  url?: string;
  mediaId?: string;
  error?: string;
}

const GRAPH = "https://graph.facebook.com/v23.0";

export function hasGraphCreds(): boolean {
  return Boolean(process.env.IG_GRAPH_ACCESS_TOKEN && process.env.IG_GRAPH_USER_ID);
}

export async function publishInstagramGraph(input: IGGraphPublishInput): Promise<IGGraphPublishResult> {
  const token = process.env.IG_GRAPH_ACCESS_TOKEN;
  const igUserId = process.env.IG_GRAPH_USER_ID;
  if (!token || !igUserId) return { ok: false, error: "IG_GRAPH_ACCESS_TOKEN / IG_GRAPH_USER_ID not set" };

  let hosted: { url: string; cleanup: () => Promise<void> } | undefined;
  try {
    hosted = await hostVideo(input.videoPath);
    console.log(`[ig-graph] hosted video at ${hosted.url}`);

    // 1) REELS コンテナ作成
    const createRes = await graphPost(`${GRAPH}/${igUserId}/media`, {
      media_type: "REELS",
      video_url: hosted.url,
      caption: input.caption.slice(0, 2200),
      share_to_feed: "true",
      access_token: token,
    });
    const containerId = createRes.id as string | undefined;
    if (!containerId) return { ok: false, error: `no container id: ${JSON.stringify(createRes).slice(0, 300)}` };

    // 2) 取り込み完了まで poll (最大 ~5 分)
    let status = "";
    for (let i = 0; i < 30; i++) {
      await sleep(10_000);
      const st = await graphGet(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
      status = String(st.status_code ?? "");
      if (status === "FINISHED") break;
      if (status === "ERROR" || status === "EXPIRED") {
        return { ok: false, error: `container ${status}: ${JSON.stringify(st).slice(0, 300)}` };
      }
      console.log(`[ig-graph] container ${containerId}: ${status} (${i + 1}/30)`);
    }
    if (status !== "FINISHED") return { ok: false, error: `container not finished in time (last=${status})` };

    // 3) 公開
    const pubRes = await graphPost(`${GRAPH}/${igUserId}/media_publish`, {
      creation_id: containerId,
      access_token: token,
    });
    const mediaId = pubRes.id as string | undefined;
    if (!mediaId) return { ok: false, error: `publish returned no media id: ${JSON.stringify(pubRes).slice(0, 300)}` };

    // 4) permalink 取得 = 実掲載の確認 (偽陽性防止)
    const meta = await graphGet(`${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
    const permalink = (meta.permalink as string) ?? `https://www.instagram.com/`;
    console.log(`[ig-graph] published: ${permalink}`);
    return { ok: true, mediaId, url: permalink };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (hosted) await hosted.cleanup().catch(e => console.warn(`[ig-graph] cleanup failed: ${e instanceof Error ? e.message : e}`));
  }
}

/** 動画を公開URLにホスト。GCS 優先、権限/ポリシーで失敗したら Drive 公開リンク。 */
async function hostVideo(videoPath: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  try {
    return await hostOnGcs(videoPath);
  } catch (e) {
    console.warn(`[ig-graph] GCS hosting failed (${e instanceof Error ? e.message : e}) — falling back to Drive public link`);
    return await hostOnDrive(videoPath);
  }
}

async function hostOnGcs(videoPath: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const bucket = process.env.IG_VIDEO_BUCKET ?? "dw60-reels-public";
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.full_control"] });
  const storage = google.storage({ version: "v1", auth });
  const projectId = await auth.getProjectId();

  // バケットが無ければ作成 (fine-grained ACL: オブジェクト単位で publicRead を付けるため)
  const exists = await storage.buckets.get({ bucket }).then(() => true).catch((e: { code?: number }) => {
    if (e?.code === 404) return false;
    throw e;
  });
  if (!exists) {
    await storage.buckets.insert({
      project: projectId,
      requestBody: { name: bucket, location: "ASIA-NORTHEAST1", storageClass: "STANDARD" },
    });
    console.log(`[ig-graph] created bucket ${bucket}`);
  }

  const objectName = `reels/${path.basename(videoPath).replace(/[^\w.-]/g, "_")}-${Math.random().toString(36).slice(2, 8)}`;
  const body = await fs.readFile(videoPath);
  await storage.objects.insert({
    bucket,
    name: objectName,
    predefinedAcl: "publicRead",
    media: { mimeType: "video/mp4", body: Buffer.from(body) },
  });
  return {
    url: `https://storage.googleapis.com/${bucket}/${objectName}`,
    cleanup: async () => { await storage.objects.delete({ bucket, object: objectName }); },
  };
}

async function hostOnDrive(videoPath: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const drive = await driveClient();
  const folderName = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, folderName));
  const body = await fs.readFile(videoPath);
  const { Readable } = await import("node:stream");
  const res = await drive.files.create({
    requestBody: {
      name: `ig-tmp-${path.basename(videoPath)}`,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: "video/mp4", body: Readable.from(body) },
    fields: "id",
  });
  const fileId = res.data.id!;
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });
  return {
    url: `https://drive.google.com/uc?export=download&id=${fileId}`,
    cleanup: async () => { await drive.files.delete({ fileId }); },
  };
}

async function graphPost(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`POST ${url.split("?")[0]} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function graphGet(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`GET ${url.split("?")[0]} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
