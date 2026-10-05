import { driveClient, findFolderId } from "../fetch-scripts-from-drive.js";

// ─── 投稿済み台帳 (posted-ledger.json): 実際に投稿した見出しを永続化し、
//     翌日・別バッチ・手動投稿分も含めて重複を防ぐ ───
export const LEDGER_NAME = "posted-ledger.json";
export const LEDGER_DAYS = 14;
export interface LedgerEntry { date: string; code: string; headline: string; videoId?: string; hookPattern?: string; hookText?: string; index?: number; rank?: number; variant?: string; url?: string; format?: "news" | "map"; }

export async function loadLedger(): Promise<{ entries: LedgerEntry[]; fileId?: string }> {
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

export async function saveLedger(fileId: string | undefined, existing: LedgerEntry[], added: LedgerEntry[], date: string): Promise<void> {
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
