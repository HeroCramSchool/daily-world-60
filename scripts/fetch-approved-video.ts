import * as fs from "node:fs";
import * as path from "node:path";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";

/**
 * publish モード時に、Drive に上がっている preview 動画とサムネ・スクリプトを取得する。
 *
 * 期待ファイル (preview phase で upload-results-to-drive.ts が置く名前):
 *   - publish-results-YYYY-MM-DD.json
 *   - video-YYYY-MM-DD.mp4
 *   - thumbnail-YYYY-MM-DD.png
 *   - voice-YYYY-MM-DD.mp3
 *
 * これらを output/YYYY-MM-DD/ に復元する。
 */

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const outDir = process.env.OUT_DIR ?? path.join("output", date);
  fs.mkdirSync(outDir, { recursive: true });

  const drive = await driveClient();
  const folderId = await findFolderId(drive, FOLDER_NAME);
  if (!folderId) throw new Error(`Folder "${FOLDER_NAME}" not found`);

  const wants: Array<{ remoteName: string; localName: string }> = [
    { remoteName: `publish-results-${date}.json`, localName: "source-from-drive.json" },
    { remoteName: `video-${date}.mp4`, localName: "final.mp4" },
    { remoteName: `thumbnail-${date}.png`, localName: "thumbnail.png" },
    { remoteName: `voice-${date}.mp3`, localName: "voice.mp3" },
  ];

  for (const w of wants) {
    const list = await drive.files.list({
      q: `'${folderId}' in parents and name = '${w.remoteName}' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 1,
    });
    const file = list.data.files?.[0];
    if (!file) {
      console.warn(`[fetch-approved] not found: ${w.remoteName}`);
      continue;
    }
    const dest = path.join(outDir, w.localName);
    const writeStream = fs.createWriteStream(dest);
    const res = await drive.files.get(
      { fileId: file.id!, alt: "media" },
      { responseType: "stream" },
    );
    await new Promise<void>((resolve, reject) => {
      (res.data as NodeJS.ReadableStream)
        .on("end", resolve)
        .on("error", reject)
        .pipe(writeStream);
    });
    console.log(`[fetch-approved] saved ${w.remoteName} -> ${dest}`);
  }

  // 復元した source-from-drive.json から scriptEn/Jp を split
  const src = path.join(outDir, "source-from-drive.json");
  if (fs.existsSync(src)) {
    const json = JSON.parse(fs.readFileSync(src, "utf-8"));
    if (json.scriptEn) {
      fs.writeFileSync(path.join(outDir, "script-en.json"), JSON.stringify(json.scriptEn, null, 2));
    }
    if (json.scriptJp) {
      fs.writeFileSync(path.join(outDir, "script-jp.json"), JSON.stringify(json.scriptJp, null, 2));
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
