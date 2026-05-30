import * as fs from "node:fs/promises";
import * as path from "node:path";
import { drive_v3, google } from "googleapis";

/**
 * Download today's scripts (en/jp) from Google Drive "Daily World 60" folder.
 *
 * Expected file in Drive: publish-results-YYYY-MM-DD.json (from Routine)
 *   includes scriptEn and scriptJp objects.
 *
 * We split it into output/YYYY-MM-DD/script-en.json and script-jp.json.
 */

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const outDir = path.join("output", date);
  await fs.mkdir(outDir, { recursive: true });

  const drive = await driveClient();
  const folderId = await findFolderId(drive, FOLDER_NAME);
  if (!folderId) throw new Error(`Drive folder "${FOLDER_NAME}" not found`);

  const candidateNames = [
    `publish-results-${date}.json`,
    `scripts-${date}.json`,
  ];

  // 同名ファイルが複数ある場合があるため、modifiedTime 降順で全部リストし、
  // scriptEn を含む最初のものを採用する。
  let json: Record<string, unknown> | undefined;
  let fileId: string | undefined;
  let fileName: string | undefined;
  outer: for (const name of candidateNames) {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and name = '${name}' and trashed = false`,
      fields: "files(id, name, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 20,
    });
    for (const f of r.data.files ?? []) {
      const res = await drive.files.get(
        { fileId: f.id!, alt: "media" },
        { responseType: "text" },
      );
      try {
        const parsed = JSON.parse(res.data as unknown as string);
        if (parsed && (parsed.scriptEn || parsed["script-en"] || parsed.script_en)) {
          fileId = f.id!;
          fileName = f.name!;
          json = parsed;
          console.log(`[drive] using ${fileName} (id=${fileId}, modified=${f.modifiedTime})`);
          break outer;
        } else {
          console.log(`[drive] skipping ${f.name} (id=${f.id}) — no scriptEn`);
        }
      } catch {
        console.log(`[drive] skipping ${f.name} (id=${f.id}) — invalid JSON`);
      }
    }
  }

  if (!json) {
    throw new Error(
      `No script file with scriptEn for ${date} in "${FOLDER_NAME}". Tried: ${candidateNames.join(", ")}`,
    );
  }

  // Routine が publish-results 形式で保存している場合
  const scriptEn = json.scriptEn ?? json["script-en"] ?? json.script_en;
  const scriptJp = json.scriptJp ?? json["script-jp"] ?? json.script_jp;

  if (!scriptEn) {
    throw new Error(`No scriptEn in ${fileName}`);
  }

  await fs.writeFile(
    path.join(outDir, "script-en.json"),
    JSON.stringify(scriptEn, null, 2),
    "utf-8",
  );
  if (scriptJp) {
    await fs.writeFile(
      path.join(outDir, "script-jp.json"),
      JSON.stringify(scriptJp, null, 2),
      "utf-8",
    );
  }

  // Source file (full publish-results) を念のため残す
  await fs.writeFile(
    path.join(outDir, "source-from-drive.json"),
    JSON.stringify(json, null, 2),
    "utf-8",
  );

  console.log(`[drive] saved -> ${outDir}/script-en.json (+ script-jp.json)`);
}

export async function driveClient(): Promise<drive_v3.Drive> {
  // Uses Application Default Credentials (ADC).
  // In GitHub Actions, google-github-actions/auth@v2 (WIF) sets these automatically.
  // Locally, run `gcloud auth application-default login` first.
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

export async function findFolderId(
  drive: drive_v3.Drive,
  name: string,
): Promise<string | undefined> {
  const r = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${name}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 5,
  });
  return r.data.files?.[0]?.id ?? undefined;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
