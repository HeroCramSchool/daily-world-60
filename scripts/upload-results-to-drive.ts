import * as fs from "node:fs";
import * as path from "node:path";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const resultsFile = path.join(dir, "publish-results.json");

  if (!fs.existsSync(resultsFile)) {
    console.warn(`[drive-upload] ${resultsFile} not found, skipping`);
    return;
  }

  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
  if (!folderId) throw new Error(`Folder "${FOLDER_NAME}" not found in Drive (set DRIVE_FOLDER_ID to override)`);

  // Upload publish-results-YYYY-MM-DD.json (overwrite if exists)
  const remoteName = `publish-results-${path.basename(dir)}.json`;
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${remoteName}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (existing.data.files && existing.data.files.length > 0) {
    await drive.files.update({
      fileId: existing.data.files[0].id!,
      media: { mimeType: "application/json", body: fs.createReadStream(resultsFile) },
    });
    console.log(`[drive-upload] updated ${remoteName}`);
  } else {
    await drive.files.create({
      requestBody: { name: remoteName, parents: [folderId] },
      media: { mimeType: "application/json", body: fs.createReadStream(resultsFile) },
    });
    console.log(`[drive-upload] created ${remoteName}`);
  }

  // v11: 3 per-story videos + 各 5 サイズ画像 + x-thread + scripts
  const extras: Array<{ local: string; remote: string; mime: string }> = [
    // Scripts
    { local: "script-en.json", remote: `script-en-${date}.json`, mime: "application/json" },
    { local: "script-jp.json", remote: `script-jp-${date}.json`, mime: "application/json" },
    { local: "x-thread.txt",   remote: `x-thread-${date}.txt`,   mime: "text/plain" },
    // 3 videos (one per story)
    { local: "news-1-cd.mp4", remote: `news-1-cd-${date}.mp4`, mime: "video/mp4" },
    { local: "news-2-kw.mp4", remote: `news-2-kw-${date}.mp4`, mime: "video/mp4" },
    { local: "news-3-sg.mp4", remote: `news-3-sg-${date}.mp4`, mime: "video/mp4" },
    // 15 social images (5 sizes × 3 stories)
    { local: "yt-thumbnail-h-cd.png", remote: `yt-thumbnail-h-cd-${date}.png`, mime: "image/png" },
    { local: "yt-thumbnail-v-cd.png", remote: `yt-thumbnail-v-cd-${date}.png`, mime: "image/png" },
    { local: "ig-reels-cover-cd.png", remote: `ig-reels-cover-cd-${date}.png`, mime: "image/png" },
    { local: "ig-feed-cd.png",        remote: `ig-feed-cd-${date}.png`,        mime: "image/png" },
    { local: "tiktok-cover-cd.png",   remote: `tiktok-cover-cd-${date}.png`,   mime: "image/png" },
    { local: "yt-thumbnail-h-kw.png", remote: `yt-thumbnail-h-kw-${date}.png`, mime: "image/png" },
    { local: "yt-thumbnail-v-kw.png", remote: `yt-thumbnail-v-kw-${date}.png`, mime: "image/png" },
    { local: "ig-reels-cover-kw.png", remote: `ig-reels-cover-kw-${date}.png`, mime: "image/png" },
    { local: "ig-feed-kw.png",        remote: `ig-feed-kw-${date}.png`,        mime: "image/png" },
    { local: "tiktok-cover-kw.png",   remote: `tiktok-cover-kw-${date}.png`,   mime: "image/png" },
    { local: "yt-thumbnail-h-sg.png", remote: `yt-thumbnail-h-sg-${date}.png`, mime: "image/png" },
    { local: "yt-thumbnail-v-sg.png", remote: `yt-thumbnail-v-sg-${date}.png`, mime: "image/png" },
    { local: "ig-reels-cover-sg.png", remote: `ig-reels-cover-sg-${date}.png`, mime: "image/png" },
    { local: "ig-feed-sg.png",        remote: `ig-feed-sg-${date}.png`,        mime: "image/png" },
    { local: "tiktok-cover-sg.png",   remote: `tiktok-cover-sg-${date}.png`,   mime: "image/png" },
  ];

  for (const e of extras) {
    const local = path.join(dir, e.local);
    if (!fs.existsSync(local)) continue;
    const stat = fs.statSync(local);
    if (stat.size > 100 * 1024 * 1024) {
      console.warn(`[drive-upload] skip ${e.local}: too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    try {
      const existingExtra = await drive.files.list({
        q: `'${folderId}' in parents and name = '${e.remote}' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
      });
      if (existingExtra.data.files && existingExtra.data.files.length > 0) {
        await drive.files.update({
          fileId: existingExtra.data.files[0].id!,
          media: { mimeType: e.mime, body: fs.createReadStream(local) },
        });
      } else {
        await drive.files.create({
          requestBody: { name: e.remote, parents: [folderId] },
          media: { mimeType: e.mime, body: fs.createReadStream(local) },
        });
      }
      console.log(`[drive-upload] uploaded ${e.remote} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      // SA quota error etc. — log and continue (publish フェーズに進める)
      console.warn(`[drive-upload] skip ${e.remote}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
