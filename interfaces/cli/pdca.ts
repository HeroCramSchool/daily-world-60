/**
 * PDCA の入口。
 *   npm run pdca -- check              台帳の検査（PR で自動実行）。見分けられる最小の差も出す
 *   npm run pdca -- learnings          experiments/learnings.md を台帳から作り直す
 *   npm run pdca -- assign <lane> <date> [index]   割り付けの確認
 *   npm run pdca -- readout            毎日: 施策ごとの判定 → Drive の experiments-report.md・Issue
 *   npm run pdca -- weekly [--force]   月曜: 週報を Issue「PDCA 週報」へ
 * 環境変数: STATS_LOCAL_FILE（Drive を使わず手元の stats-history.json を読む）、STATS_OUT_DIR（レポートを手元に書く）、
 *          PDCA_DRY=1（Issue も Drive も書かない）、PDCA_TODAY=YYYY-MM-DD（判定日の確認用）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { drive_v3 } from "googleapis";
import { validateRegistry, learningsMarkdown, isLive, type Lane, type Registry } from "../../domain/experiment/Experiment.js";
import { minDetectableRatio, nPerArmFor } from "../../domain/experiment/Power.js";
import { armsFor, hookLayoutFor } from "../../domain/experiment/Assignment.js";
import { readoutExperiments, renderReport, issueFor, weeklySummary, type VideoFact, type Ctx } from "../../application/usecases/ReadoutExperiments.js";
import { loadRegistry, LEARNINGS_PATH } from "../../infrastructure/pdca/RegistryFile.js";
import { DRY, gitChanges, failedRuns, upsertIssue, postWeekly, stepSummary } from "../../infrastructure/pdca/PdcaSinks.js";
import { loadHistory, localFile, upsertTextFile, viewsAt, ageHours } from "../../scripts/lib/stats.js";
import { driveClient, findFolderId } from "../../scripts/fetch-scripts-from-drive.js";

const AT_HOURS = 168;
const REPORT_NAME = "experiments-report.md";
const today = () => process.env.PDCA_TODAY?.trim() || new Date().toISOString().slice(0, 10);

function check(reg: Registry): number {
  const { errors, warnings } = validateRegistry(reg);
  for (const e of reg.experiments) {
    if (e.status === "idea") { console.log(`· ${e.id}  idea  ${e.title}`); continue; }
    const mark = errors.some(m => m.startsWith(`${e.id}:`)) ? "✗" : "✓";
    console.log(`${mark} ${e.id}  ${e.status}  ${e.design ?? "?"}  腕: ${(e.arms ?? []).join(" / ")}（${e.armSource?.by === "hash" ? "乱数" : `項目 ${e.armSource && "field" in e.armSource ? e.armSource.field : "?"}`}・${e.unit ?? "?"}）`);
    if (e.expectedPerArm) {
      console.log(`    1群${e.expectedPerArm}本で見分けられる差: ${minDetectableRatio(e.expectedPerArm, reg.sigma).toFixed(1)}倍`);
      console.log(`    2倍を見るには1群${nPerArmFor(2, reg.sigma)}本、1.5倍なら${nPerArmFor(1.5, reg.sigma)}本`);
    }
  }
  const expected = learningsMarkdown(reg);
  const actual = fs.existsSync(LEARNINGS_PATH) ? fs.readFileSync(LEARNINGS_PATH, "utf-8") : "";
  if (expected !== actual) errors.push("experiments/learnings.md が台帳と合っていない: npm run pdca -- learnings で作り直す");
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const m of errors) console.log(`✗ ${m}`);
  console.log(errors.length ? `\n✗ ${errors.length} 件のエラー` : `\n✓ 台帳の検査を通った（${reg.experiments.length} 件）`);
  return errors.length ? 1 : 0;
}

async function videoFacts(): Promise<{ videos: VideoFact[]; drive?: drive_v3.Drive; folderId?: string }> {
  let drive: drive_v3.Drive | undefined;
  let folderId: string | undefined;
  if (!localFile()) {
    drive = await driveClient();
    folderId = process.env.DRIVE_FOLDER_ID ?? (await findFolderId(drive, process.env.DRIVE_FOLDER_NAME ?? "Daily World 60"));
    if (!folderId) throw new Error("Drive folder not found");
  }
  const { history } = await loadHistory(drive, folderId);
  // PDCA_TODAY を指定したら、その日の終わりを「今」として7日判定をそろえる
  const now = process.env.PDCA_TODAY?.trim() ? Date.parse(`${today()}T23:59:59Z`) : Date.now();
  const videos: VideoFact[] = Object.values(history.videos).filter(v => v.snapshots.length).map(v => ({
    videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, scriptDate: v.scriptDate,
    format: v.format, variant: v.variant, rank: v.rank, index: v.index, exp: v.exp, arm: v.arm,
    at7d: ageHours(v, now) >= AT_HOURS ? viewsAt(v, AT_HOURS) : undefined,
  }));
  return { videos, drive, folderId };
}

const ctxOf = (): Ctx => ({ today: today(), gitChanges, failedRuns });

async function readout(reg: Registry): Promise<void> {
  const { videos, drive, folderId } = await videoFacts();
  const ctx = ctxOf();
  const rs = readoutExperiments(reg, videos, ctx);
  const md = renderReport(reg, rs, ctx.today);
  const outDir = process.env.STATS_OUT_DIR?.trim();
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, REPORT_NAME), md, "utf-8");
    console.log(`[pdca] wrote ${path.join(outDir, REPORT_NAME)}`);
  } else if (DRY || !drive || !folderId) {
    console.log(md);
  } else {
    try {
      await upsertTextFile(drive, folderId, REPORT_NAME, md);
      console.log(`[pdca] wrote Drive -> ${REPORT_NAME}`);
    } catch (e) {
      console.warn(`::warning::${REPORT_NAME} を Drive に書けない（${e instanceof Error ? e.message : e}）。実行画面の要約と Issue には出す`);
    }
  }
  stepSummary(md);
  for (const r of rs) {
    console.log(`[pdca] ${r.exp.id}: ${r.phase} (${r.verdict.state}) rows=${r.rows} pending=${r.pending}`);
    const issue = issueFor(r, reg.sigma);
    if (issue) console.log(`[pdca] issue ${upsertIssue(issue.title, issue.body)}`);
  }
}

async function weekly(reg: Registry, force: boolean): Promise<void> {
  const ctx = ctxOf();
  const dow = new Date(`${ctx.today}T00:00:00Z`).getUTCDay();
  if (dow !== 1 && !force) { console.log(`[pdca] weekly: 月曜ではない（${ctx.today}）ので出さない。--force で出せる`); return; }
  const { videos } = await videoFacts();
  const rs = readoutExperiments(reg, videos, ctx);
  const body = weeklySummary(reg, rs, videos, ctx);
  stepSummary(body);
  console.log(`[pdca] weekly ${postWeekly(body)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const reg = loadRegistry();
  switch (cmd) {
    case "check":
      process.exitCode = check(reg);
      return;
    case "learnings":
      fs.writeFileSync(LEARNINGS_PATH, learningsMarkdown(reg), "utf-8");
      console.log(`[pdca] wrote ${LEARNINGS_PATH}`);
      return;
    case "assign": {
      const [lane, date, index = "1"] = rest;
      if (!lane || !date) throw new Error("usage: pdca assign <lane> <YYYY-MM-DD> [index]");
      const live = reg.experiments.filter(isLive);
      console.log(JSON.stringify({ ...armsFor(live, [lane as Lane], date, Number(index)), hookLayout: hookLayoutFor(live, date, Number(index)) }));
      return;
    }
    case "readout":
      await readout(reg);
      return;
    case "weekly":
      await weekly(reg, rest.includes("--force"));
      return;
    default:
      console.log("usage: pdca <check|learnings|assign|readout|weekly>");
      process.exitCode = 2;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
