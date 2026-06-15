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
  const outDir = process.env.OUT_DIR ?? path.join("output", date);
  await fs.mkdir(outDir, { recursive: true });

  let json: Record<string, unknown> | undefined;
  let fileId: string | undefined;
  let fileName: string | undefined;

  // ローカル上書き: SCRIPT_SOURCE_FILE が指定されたら Drive を読まず、そのファイル
  // (publish-results 形式 = {scriptEn, scriptJp}) を台本ソースにする。
  // 独自トピックのショートを流す用 (Drive に書けない環境向け)。空なら従来どおり Drive 取得。
  const overrideFile = process.env.SCRIPT_SOURCE_FILE?.trim();
  if (overrideFile) {
    json = JSON.parse(await fs.readFile(overrideFile, "utf-8"));
    fileName = overrideFile;
    console.log(`[drive] using LOCAL override script source: ${overrideFile}`);
  }

  // 関数スコープで宣言 (Drive ループと not-found throw の両方から参照するため)。
  const candidateNames = [
    `publish-results-${date}.json`,
    `scripts-${date}.json`,
  ];

  if (!json) {
    const drive = await driveClient();
    const folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
    if (!folderId) throw new Error(`Drive folder "${FOLDER_NAME}" not found (set DRIVE_FOLDER_ID to override)`);

    // 同名ファイルが複数ある場合があるため、modifiedTime 降順で全部リストし、
    // scriptEn を含む最初のものを採用する。
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
  }

  if (!json) {
    // 04d6d08 fixed the root cause (upload no longer clobbers the Routine's
    // script file). Defense-in-depth: a genuinely missing script for a scheduled
    // batch just means "nothing to publish", which should be a clean no-op — not
    // a hard failure that spams CI failure emails. Write an empty script so the
    // downstream steps (tts/build/publish) loop over zero stories and succeed.
    console.warn(
      `[drive] No script file with scriptEn for ${date} in "${FOLDER_NAME}" (tried: ${candidateNames.join(", ")}). Nothing to publish — writing empty script and skipping.`,
    );
    await fs.writeFile(
      path.join(outDir, "script-en.json"),
      JSON.stringify({ date, stories: [] }, null, 2),
      "utf-8",
    );
    return;
  }

  // Routine が publish-results 形式で保存している場合
  const scriptEnRaw = json.scriptEn ?? json["script-en"] ?? json.script_en;
  const scriptJpRaw = json.scriptJp ?? json["script-jp"] ?? json.script_jp;

  if (!scriptEnRaw) {
    throw new Error(`No scriptEn in ${fileName}`);
  }

  // Normalize to pipeline schema (domain/script/Script.ts).
  // Routine outputs sometimes use `country: "CD", flag: "🇨🇩"` (flat) instead of `country: { code, flag }`.
  const scriptEn = normalizeScript(scriptEnRaw as Record<string, unknown>, date, "en");
  const scriptJp = scriptJpRaw ? normalizeScript(scriptJpRaw as Record<string, unknown>, date, "jp") : undefined;

  // ─── Batch slice: Routine の 9 ストーリー出力を朝昼夜 3 本ずつに分割 (BATCH=1/2/3) ───
  // OUT_DIR / BATCH は publish.yml が設定。未設定(batch=0)なら全ストーリーをそのまま使う(後方互換)。
  const batch = process.env.BATCH ? Number(process.env.BATCH) : 0;
  if (batch >= 1) {
    const start = (batch - 1) * 3;
    const sliceInPlace = (s: Record<string, unknown> | undefined): number => {
      if (!s || !Array.isArray(s.stories)) return 0;
      s.stories = (s.stories as Record<string, unknown>[])
        .slice(start, start + 3)
        .map((st, i) => ({ ...st, index: i + 1 }));
      return (s.stories as unknown[]).length;
    };
    const kept = sliceInPlace(scriptEn as Record<string, unknown>);
    sliceInPlace(scriptJp as Record<string, unknown> | undefined);
    console.log(`[drive] BATCH=${batch}: kept ${kept} stories (offset ${start})`);
    if (kept === 0) console.warn(`[drive] BATCH=${batch}: empty batch — source needs >= ${start + 1} stories`);
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

// JP raw could be `[{tweetIndex,text}, ...]` (Routine v2 shape) OR `string[]` OR `{stories,...}` (Script object).
// We support all three; downstream pipeline expects the Script object shape for stories rendering, and a flat thread array for X.
type RawStory = {
  index?: number;
  country?: string | { code?: string; flag?: string; name?: string };
  flag?: string;
  region?: string;
  headline?: string;
  summary?: string;
  sourceName?: string;
  sourceUrl?: string;
  imageQueries?: string[];
  keyword?: { word?: string; definitionEn?: string };
  hookText?: string;
  hookPattern?: string;
  commentQuestion?: string;
};

function normalizeScript(
  raw: Record<string, unknown>,
  date: string,
  language: "en" | "jp",
): Record<string, unknown> {
  // JP-only: if the entire payload is just an array (tweets), wrap minimally
  if (Array.isArray(raw)) {
    return { date, language, hook: "", stories: [], todaysWord: {}, close: "", thread: raw };
  }

  const stories = Array.isArray(raw.stories) ? (raw.stories as RawStory[]) : [];
  const sharedWord = raw.todaysWord as { word?: string; definitionEn?: string } | undefined;
  const normStories = stories.map((s, i) => {
    let countryCode = "";
    let countryFlag = "";
    let countryName: string | undefined;
    if (typeof s.country === "string") {
      countryCode = s.country;
      countryFlag = s.flag ?? "";
    } else if (s.country && typeof s.country === "object") {
      countryCode = s.country.code ?? "";
      countryFlag = s.country.flag ?? s.flag ?? "";
      countryName = s.country.name;
    }
    // keyword: story 固有 → 無ければ script 共通の todaysWord にフォールバック
    // (ESL キーワード解説 = inauthentic 対策の明文の教育価値。落とさない)
    const kw = (s.keyword?.word && s.keyword?.definitionEn)
      ? { word: s.keyword.word, definitionEn: s.keyword.definitionEn }
      : (sharedWord?.word && sharedWord?.definitionEn)
        ? { word: sharedWord.word, definitionEn: sharedWord.definitionEn }
        : undefined;
    return {
      index: s.index ?? i + 1,
      country: { code: countryCode, flag: countryFlag, ...(countryName ? { name: countryName } : {}) },
      headline: s.headline ?? "",
      summary: s.summary ?? "",
      sourceName: s.sourceName ?? "",
      sourceUrl: s.sourceUrl ?? "",
      ...(kw ? { keyword: kw } : {}),
      ...(Array.isArray(s.imageQueries) && s.imageQueries.length ? { imageQueries: s.imageQueries } : {}),
      ...(s.hookText ? { hookText: s.hookText } : {}),
      ...(s.hookPattern ? { hookPattern: s.hookPattern } : {}),
      ...(s.commentQuestion ? { commentQuestion: s.commentQuestion } : {}),
    };
  });

  return {
    date,
    language,
    hook: (raw.hook as string) ?? "",
    stories: normStories,
    todaysWord: raw.todaysWord ?? {},
    close: (raw.close as string) ?? "",
    estimatedSeconds: raw.estimatedSeconds ?? 60,
  };
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

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
