import * as fs from "node:fs/promises";
import * as path from "node:path";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";

/**
 * 週次 Routine が Drive に保存した longform-YYYY-MM-DD.json を取得し、
 * output/YYYY-MM-DD/longform.json として保存する。
 */
const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const outDir = process.env.OUT_DIR ?? path.join("output", date);
  await fs.mkdir(outDir, { recursive: true });

  const drive = await driveClient();
  const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
  if (!folderId) throw new Error(`Drive folder "${FOLDER_NAME}" not found`);

  const name = `longform-${date}.json`;
  const r = await drive.files.list({
    q: `'${folderId}' in parents and name = '${name}' and trashed = false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 10,
  });
  for (const f of r.data.files ?? []) {
    const res = await drive.files.get({ fileId: f.id!, alt: "media" }, { responseType: "text" });
    try {
      const parsed = JSON.parse(res.data as unknown as string);
      if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
        await fs.writeFile(path.join(outDir, "longform.json"), JSON.stringify(parsed, null, 2), "utf-8");
        console.log(`[longform-fetch] ${name} (id=${f.id}) -> ${outDir}/longform.json (${parsed.sections.length} sections)`);
        return;
      }
      console.log(`[longform-fetch] skip ${f.name} (id=${f.id}) — no sections`);
    } catch {
      console.log(`[longform-fetch] skip ${f.name} (id=${f.id}) — invalid JSON`);
    }
  }
  throw new Error(`No valid ${name} (with sections) in "${FOLDER_NAME}"`);
}

main().catch(e => { console.error(e); process.exit(1); });
