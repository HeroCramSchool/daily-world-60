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
  const folderId = await findFolderId(drive, FOLDER_NAME);
  if (!folderId) throw new Error(`Folder "${FOLDER_NAME}" not found in Drive`);

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

  // Also upload final.mp4 if it exists (size permitting)
  const videoFile = path.join(dir, "final.mp4");
  if (fs.existsSync(videoFile)) {
    const stat = fs.statSync(videoFile);
    if (stat.size < 100 * 1024 * 1024) {
      // < 100 MB
      const videoName = `video-${date}.mp4`;
      const existingVideo = await drive.files.list({
        q: `'${folderId}' in parents and name = '${videoName}' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
      });
      if (existingVideo.data.files && existingVideo.data.files.length > 0) {
        await drive.files.update({
          fileId: existingVideo.data.files[0].id!,
          media: { mimeType: "video/mp4", body: fs.createReadStream(videoFile) },
        });
      } else {
        await drive.files.create({
          requestBody: { name: videoName, parents: [folderId] },
          media: { mimeType: "video/mp4", body: fs.createReadStream(videoFile) },
        });
      }
      console.log(`[drive-upload] uploaded ${videoName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
