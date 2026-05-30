import * as fs from "node:fs";
import * as path from "node:path";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const resultsFile = path.join(dir, "publish-results.json");

  if (!fs.existsSync(resultsFile)) {
    console.warn(`[drive-upload] ${resultsFile} not found, skipping`);
    return;
  }

  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
  if (!folderId) throw new Error(`Folder "${FOLDER_NAME}" not found in Drive (set DRIVE_FOLDER_ID to override)`);

  // Upload publish-results-YYYY-MM-DD.json (overwrite if exists)
  const remoteName = `publish-results-${date}.json`;
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

  // Also upload final.mp4, voice.mp3, thumbnails and social images if they exist
  const extras: Array<{ local: string; remote: string; mime: string }> = [
    { local: "final.mp4",        remote: `video-${date}.mp4`,        mime: "video/mp4" },
    { local: "voice.mp3",        remote: `voice-${date}.mp3`,        mime: "audio/mpeg" },
    { local: "thumbnail.png",    remote: `thumbnail-${date}.png`,    mime: "image/png" },
    { local: "yt-thumbnail.png", remote: `yt-thumbnail-${date}.png`, mime: "image/png" },
    { local: "ig-feed.png",      remote: `ig-feed-${date}.png`,      mime: "image/png" },
    { local: "ig-story.png",     remote: `ig-story-${date}.png`,     mime: "image/png" },
    { local: "x-card.png",       remote: `x-card-${date}.png`,       mime: "image/png" },
  ];

  for (const e of extras) {
    const local = path.join(dir, e.local);
    if (!fs.existsSync(local)) continue;
    const stat = fs.statSync(local);
    if (stat.size > 100 * 1024 * 1024) {
      console.warn(`[drive-upload] skip ${e.local}: too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
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
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
