import * as fs from "node:fs/promises";
import * as path from "node:path";
import { driveClient, findFolderId } from "./fetch-scripts-from-drive.js";
import {
  TRACK_DAYS, type VideoStat, loadHistory, localFile, upsertTextFile, viewsAt, ageHours,
} from "./lib/stats.js";
import type { drive_v3 } from "googleapis";

/**
 * stats-history.json から勝ちパターンを抽出し Drive に2ファイル書く:
 *  - winning-patterns.md … Routine が台本生成前に読む短い参考重み (ハードゲート優先を明記)
 *  - stats-report.md     … オーナー向けの全動画テーブル
 * 比較は公開48h時点の視聴数 (any-play 水増し対策として同チャンネル内の相対比較のみ)。
 */

const FOLDER_NAME = process.env.DRIVE_FOLDER_NAME ?? "Daily World 60";
// 実測補正 (2026-07-28): 動画は1-2週かけて伸びるので 48h 比較は無意味だった
// (若い動画 vs 成熟動画を比べていた)。7日時点で比較し、7日未満はコホートから除外。
const COHORT_DAYS = 35;
const MIN_COHORT = 8;
const AT_HOURS = 168;

type Row = {
  v: VideoStat;
  at48?: number;
  current: number;
  ageDays: number;
};

const TOPIC_BUCKETS: Array<[string, RegExp]> = [
  ["conflict", /strike|attack|kill|war|drone|missile|troop|bomb|shot|shell|invasion|ships hit|front line/i],
  ["disaster", /quake|tsunami|flood|fire|storm|hurricane|typhoon|erupt|landslide|collapse|derail/i],
  ["health", /ebola|virus|outbreak|vaccine|cholera|plague|infect|hospital/i],
  ["space", /starship|rocket|nasa|spacex|launch|orbit|moon|mars|satellite/i],
  ["sports", /world cup|final|olympic|match|championship|messi/i],
  ["economy", /market|inflation|bank|oil|tariff|price|crash|currency/i],
  ["politics", /election|president|parliament|coup|sanction|minister|vote/i],
];

function topicBucket(v: VideoStat): string {
  const text = `${v.headline ?? ""} ${v.title}`;
  for (const [name, re] of TOPIC_BUCKETS) if (re.test(text)) return name;
  return "other";
}

function slot(v: VideoStat): string {
  const h = new Date(v.publishedAt).getUTCHours();
  return h >= 12 && h < 18 ? "UTC-afternoon" : "UTC-evening";
}

function features(v: VideoStat): Array<[string, string]> {
  return [
    ["country", v.code ?? "?"],
    ["topic", topicBucket(v)],
    ["hook", v.hookPattern ?? "?"],
    ["number-first", /^\d/.test(v.title) ? "yes" : "no"],
    ["slot", slot(v)],
  ];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const now = Date.now();
  let drive: drive_v3.Drive | undefined;
  let folderId: string | undefined;
  if (!localFile()) {
    drive = await driveClient();
    folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, FOLDER_NAME));
    if (!folderId) throw new Error(`Drive folder "${FOLDER_NAME}" not found`);
  }

  const { history } = await loadHistory(drive, folderId);
  const rows: Row[] = Object.values(history.videos)
    .filter(v => v.snapshots.length > 0)
    .map(v => ({
      v,
      at48: viewsAt(v, AT_HOURS),
      current: v.snapshots[v.snapshots.length - 1].views,
      ageDays: ageHours(v, now) / 24,
    }));

  const cohort = rows.filter(r => r.at48 !== undefined && r.ageDays <= COHORT_DAYS && ageHours(r.v, now) >= AT_HOURS);
  const today = new Date(now).toISOString().slice(0, 10);

  let patterns: string;
  if (cohort.length < MIN_COHORT) {
    patterns = [
      `# Winning Patterns (auto, ${today})`,
      ``,
      `データ不足: 48h計測済みが ${cohort.length} 本 (${MIN_COHORT} 本以上で分析開始)。`,
      `参考重みは無し。既存ルール (ハードゲート・分散・新展開限定) のとおり選定してください。`,
    ].join("\n");
    console.log(`[analyze] insufficient data: ${cohort.length}/${MIN_COHORT} — wrote stub`);
  } else {
    const med = median(cohort.map(r => r.at48!));
    const winners = cohort.filter(r => r.at48! >= 2 * med && r.at48! >= 30);
    const losers = cohort.filter(r => r.at48! <= 0.5 * med);

    // 特徴値ごとの 勝ち/負け/全体 集計
    const tally = new Map<string, { win: number; lose: number; total: number }>();
    for (const r of cohort) {
      for (const [k, val] of features(r.v)) {
        const key = `${k}=${val}`;
        const t = tally.get(key) ?? { win: 0, lose: 0, total: 0 };
        t.total++;
        if (winners.includes(r)) t.win++;
        if (losers.includes(r)) t.lose++;
        tally.set(key, t);
      }
    }
    const signals = [...tally.entries()]
      .filter(([, t]) => t.total >= 3 && (t.win > 0 || t.lose > 0))
      .sort((a, b) => (b[1].win / b[1].total) - (a[1].win / a[1].total) || b[1].total - a[1].total);

    const fmt = (r: Row) => `- ${r.v.title.replace(/ #Shorts.*$/, "")} — ${r.at48} views@48h (${r.v.code ?? "?"}/${topicBucket(r.v)}/${r.v.hookPattern ?? "?"})`;
    patterns = [
      `# Winning Patterns (auto, ${today})`,
      ``,
      `直近${COHORT_DAYS}日 ${cohort.length}本を公開7日時点の視聴数で比較 (中央値 ${med})。`,
      `公開視聴数は絶対値が水増しされるため相対比較のみ。本chは1-2週で伸びるため7日時点で評価。`,
      ``,
      `## 勝ち (>=2x中央値)`,
      ...(winners.length ? winners.sort((a, b) => b.at48! - a.at48!).map(fmt) : ["- なし"]),
      ``,
      `## 負け (<=0.5x中央値)`,
      ...(losers.length ? losers.sort((a, b) => a.at48! - b.at48!).map(fmt) : ["- なし"]),
      ``,
      `## 特徴シグナル (勝ち数/負け数/本数)`,
      ...signals.slice(0, 12).map(([key, t]) => `- ${key}: ${t.win}勝/${t.lose}負/${t.total}本`),
      ``,
      `## 適用ルール (Routine 向け)`,
      `これは参考重みであり命令ではない。ハードゲート (新展開限定・スポーツ厳格化・`,
      `メガトピック分散上限・交渉/追悼除外・ソース検証) が常に優先。`,
      `同格の候補が並んだ時のタイブレークとしてのみ、勝ち特徴を優先し負け特徴を避ける。`,
      `特徴シグナルは3本以上の集計のみ掲載。それでも本数が少ないものは偶然があり得るため弱い参考に留める。`,
    ].join("\n");
    console.log(`[analyze] cohort=${cohort.length} median=${med} winners=${winners.length} losers=${losers.length}`);
  }

  const tracked = rows.filter(r => r.ageDays <= TRACK_DAYS).sort((a, b) => (b.at48 ?? b.current) - (a.at48 ?? a.current));
  const report = [
    `# DW60 stats report (auto, ${today})`,
    ``,
    `| title | code | published | views@7d | now | age(d) |`,
    `|---|---|---|---|---|---|`,
    ...tracked.map(r =>
      `| ${r.v.title.replace(/ #Shorts.*$/, "").replace(/\|/g, "/").slice(0, 48)} | ${r.v.code ?? "?"} | ${r.v.publishedAt.slice(0, 10)} | ${r.at48 ?? "-"} | ${r.current} | ${r.ageDays.toFixed(1)} |`,
    ),
    ``,
    `追跡 ${tracked.length} 本 / 履歴 ${rows.length} 本。views@7d "-" = 7日時点の値が無い動画 (追跡開始前公開/まだ7日未満)。`,
    `公開14日を超えた動画は視聴数の更新を停止するため now は最終記録値。`,
  ].join("\n");

  const outDir = process.env.STATS_OUT_DIR?.trim();
  if (outDir) {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "winning-patterns.md"), patterns, "utf-8");
    await fs.writeFile(path.join(outDir, "stats-report.md"), report, "utf-8");
    console.log(`[analyze] wrote local -> ${outDir}/{winning-patterns.md,stats-report.md}`);
  } else if (drive && folderId) {
    await upsertTextFile(drive, folderId, "winning-patterns.md", patterns);
    await upsertTextFile(drive, folderId, "stats-report.md", report);
    console.log(`[analyze] wrote Drive -> winning-patterns.md, stats-report.md`);
  } else {
    console.log(patterns);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
