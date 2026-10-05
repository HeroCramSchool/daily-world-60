import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { publishYoutube } from "./publishers/youtube.js";
import { loadLedger, saveLedger, type LedgerEntry } from "./lib/ledger.js";

/**
 * Map Short (月・水・金): 「各国の○○」塗り分け地図 1 枚・5〜9 秒・無音を 1 本投稿する。
 * 契約: docs/map-short.md
 *
 *   npx tsx scripts/publish-map.ts <mapId|auto>
 *
 * 入力:  content/maps/registry.json (地図定義) + content/maps/posted.json (投稿済み台帳)
 * 工程:  prep-map.ts → remotion render MapShort → YouTube → posted.json 追記 → Drive 台帳 (best effort)
 * 出力:  remotion/out/map-<id>.mp4, output/maps/<date>-<id>.json
 *
 * env:  DRY_RUN=1     投稿せずペイロードを表示して終了 (何も書かない)
 *       SKIP_RENDER=1 prep/render を飛ばす (remotion 側未完成時の疎通確認用)
 *       MAPS_DIR      registry.json / posted.json の場所 (既定 content/maps)
 *       FORCE_REPUBLISH=true 明示 id が投稿済みでも再投稿する
 */

interface MapLegend { key: string; label: string; color: string }
interface MapSource { name: string; url: string; year: number; fetchedAt?: string }
interface MapDef {
  id: string;
  title: string;
  shortTitle: string;
  cta?: string;
  legend: MapLegend[];
  data: Record<string, string>;
  unknownLabel?: string;
  source: MapSource;
  notes?: string;
  /** 説明文の 2 行目に載せる補足 (集計の前提など) */
  descriptionNote?: string;
  durationSec?: number;
}
interface Registry { maps: MapDef[] }
interface Country { cca3: string; ccn3?: string }
interface PostedEntry { id: string; date: string; videoId: string; url: string }
interface Posted { posted: PostedEntry[] }

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const MAPS_DIR = process.env.MAPS_DIR ? path.resolve(process.env.MAPS_DIR) : path.join(ROOT, "content", "maps");
const REMOTION_DIR = path.join(ROOT, "remotion");
const DRY_RUN = process.env.DRY_RUN === "1" || (process.env.DRY_RUN ?? "").toLowerCase() === "true";
const SKIP_RENDER = process.env.SKIP_RENDER === "1";
const FORCE_REPUBLISH = (process.env.FORCE_REPUBLISH ?? "").toLowerCase() === "true";
const TITLE_SUFFIX = " 🌍 #shorts";
const TITLE_MAX = 100;
const MIN_VIDEO_BYTES = 100 * 1024;
const EXHAUST_WARN_LEFT = 2;

async function main() {
  const arg = (process.argv[2] ?? "auto").trim();
  const date = new Date().toISOString().slice(0, 10);

  const registry: Registry = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "registry.json"), "utf-8"));
  const maps = Array.isArray(registry.maps) ? registry.maps : [];
  const posted = await loadPosted();
  const postedIds = new Set(posted.posted.map(p => p.id));

  let map: MapDef | undefined;
  if (arg === "auto") {
    map = maps.find(m => !postedIds.has(m.id));
    if (!map) {
      console.log(`::error::map registry exhausted — ${postedIds.size}/${maps.length} maps in registry are already in posted.json; add maps to content/maps/registry.json`);
      process.exit(1);
    }
  } else {
    map = maps.find(m => m.id === arg);
    if (!map) throw new Error(`map "${arg}" not found in ${path.join(MAPS_DIR, "registry.json")}`);
    if (postedIds.has(map.id) && !FORCE_REPUBLISH) {
      throw new Error(`map "${arg}" is already in posted.json (set FORCE_REPUBLISH=true to re-post)`);
    }
  }
  console.log(`[map] selected: ${map.id} (${arg === "auto" ? "auto" : "explicit"}) — ${postedIds.size}/${maps.length} posted so far`);
  const left = maps.filter(m => !postedIds.has(m.id) && m.id !== map!.id).length;
  if (left <= EXHAUST_WARN_LEFT) console.log(`::warning::map registry nearly exhausted (${left} left) — add maps to content/maps/registry.json`);
  const drawable = await loadDrawableCca3();

  const videoPath = path.join(REMOTION_DIR, "out", `map-${map.id}.mp4`);
  if (SKIP_RENDER) {
    console.log(`[map] SKIP_RENDER=1 — skipping prep/render (expects ${videoPath})`);
  } else {
    // prep: registry + countries → remotion/props-map.json。render は publish.yml Step Cr / render-shorts.mjs と同じ呼び方
    run("npx", ["tsx", "remotion/prep-map.ts", map.id], ROOT);
    run("npx", ["remotion", "render", "MapShort", `out/map-${map.id}.mp4`, "--codec=h264", "--muted", "--log=error"], REMOTION_DIR);
  }

  const title = buildTitle(map.shortTitle);
  const description = buildDescription(map, date, drawable);
  const tags = buildTags(map);
  const payload = { videoPath, title, description, tags };

  if (DRY_RUN) {
    console.log(`[map] DRY_RUN=1 — would upload:\n${JSON.stringify(payload, null, 2)}`);
    return;
  }

  const stat = await fs.stat(videoPath).catch(() => { throw new Error(`rendered video not found: ${videoPath}`); });
  if (stat.size <= MIN_VIDEO_BYTES) throw new Error(`rendered video too small (${stat.size} bytes ≤ ${MIN_VIDEO_BYTES}): ${videoPath}`);

  const yt = await publishYoutube(payload);
  console.log(`[map] YouTube:`, yt.ok ? `✓ ${yt.url}` : `✗ ${yt.error}`);
  if (!yt.ok || !yt.videoId || !yt.url) throw new Error(`YouTube upload failed: ${yt.error ?? "no videoId"}`);

  // posted.json が重複防止の正本。先に書き、ワークフローがコミットして戻す
  posted.posted.push({ id: map.id, date, videoId: yt.videoId, url: yt.url });
  await fs.writeFile(path.join(MAPS_DIR, "posted.json"), JSON.stringify(posted, null, 2) + "\n", "utf-8");
  console.log(`[map] posted.json: +${map.id} (total ${posted.posted.length})`);

  // Drive 台帳は stats ループ (collect-stats → analyze-winners) が format=map で分けて集計するため。失敗しても投稿は成立
  const ledgerEntry: LedgerEntry = {
    headline: map.shortTitle, code: "WORLD", date,
    videoId: yt.videoId, url: yt.url,
    index: 0, rank: 0, variant: "map", format: "map",
  };
  let ledgerStatus = "ok";
  try {
    const ledger = await loadLedger();
    if (ledger.fileId && ledger.entries.length === 0) {
      // 既存ファイルが読めなかった (parse 失敗等) 可能性が高い。news の履歴を空で上書きしない
      ledgerStatus = "skipped: ledger file exists but 0 entries were read (not overwriting)";
      console.warn(`[map] ledger append ${ledgerStatus}`);
    } else {
      await saveLedger(ledger.fileId, ledger.entries, [ledgerEntry], date);
    }
  } catch (e) {
    ledgerStatus = `failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[map] ledger append failed (continuing): ${ledgerStatus}`);
  }

  const outDir = path.join(ROOT, "output", "maps");
  await fs.mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, `${date}-${map.id}.json`);
  await fs.writeFile(resultPath, JSON.stringify({
    id: map.id, date, title, description, tags, videoPath,
    youtube: yt, ledger: ledgerStatus, ledgerEntry,
  }, null, 2), "utf-8");
  console.log(`[map] Done. Result → ${resultPath}`);
}

/** countries.json で ccn3 を持つ cca3 (= world-atlas で描ける国)。説明文の件数を動画の凡例と一致させる */
async function loadDrawableCca3(): Promise<Set<string>> {
  const parsed = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "countries.json"), "utf-8"));
  const list: Country[] = Array.isArray(parsed) ? parsed : parsed?.countries ?? [];
  return new Set(list.filter(c => c.cca3 && c.ccn3).map(c => c.cca3.toUpperCase()));
}

async function loadPosted(): Promise<Posted> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "posted.json"), "utf-8"));
    return { posted: Array.isArray(parsed?.posted) ? parsed.posted : [] };
  } catch {
    return { posted: [] };
  }
}

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`[map] $ ${cmd} ${args.join(" ")}  (cwd ${path.relative(ROOT, cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} ${args[1] ?? ""} exited with ${r.status ?? r.signal}`);
}

/** `${shortTitle} 🌍 #shorts` を 100 字以内に (youtube.ts の slice(0,100) と同じコード単位)。任せるとハッシュタグ側が切れる */
function buildTitle(shortTitle: string): string {
  const head = shortTitle.trim();
  const room = TITLE_MAX - TITLE_SUFFIX.length;
  const trimmed = head.length > room ? head.slice(0, room - 1).trimEnd() + "…" : head;
  return `${trimmed}${TITLE_SUFFIX}`;
}

function buildDescription(map: MapDef, date: string, drawable: Set<string>): string {
  // 凡例ごとの件数 (data は cca3 → legend key)。ccn3 の無い cca3 は描かれないので数えない
  const counts = new Map<string, number>();
  for (const [cca3, k] of Object.entries(map.data)) {
    if (!drawable.has(cca3.toUpperCase())) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const legendLine = map.legend
    .map(l => `${l.label} ${counts.get(l.key) ?? 0}`)
    .join(" · ");
  const lines = [
    `${map.shortTitle} — ${legendLine} (countries & territories).`,
    ...(map.descriptionNote ? [map.descriptionNote] : []),
    ...(map.cta ? ["", `💬 ${map.cta}`] : []),
    "",
    `Source: ${map.source.name} (${map.source.year}) ${map.source.url}`,
    "Map is schematic (Natural Earth 110m); borders and territories simplified.",
    "",
    // 以下は publish-all.ts buildYoutubeDescription と同じ channel 行 (ナレーション/AI 画像の開示行は無音の地図には当てはまらないので省く)
    `${date} · Daily World 60`,
    "Subscribe for daily 60-second world news from around the world.",
    "",
    "📩 Send this to a friend who's learning English.",
    "",
    "Educational data map for general information only. Please verify details with the original source linked above.",
    "Not affiliated with any government or publisher. No narration; map rendered from the cited dataset.",
    "",
    `#Shorts #Map #Geography #${map.id.replace(/-/g, "")}`,
  ];
  return lines.join("\n");
}

function buildTags(map: MapDef): string[] {
  const idWords = map.id.split(/[-_]+/).filter(w => w.length > 2);
  const phrase = idWords.length > 1 ? [idWords.join(" ")] : [];
  return [...new Set(["map", "geography", "world", "countries", ...idWords, ...phrase, "shorts"])];
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
