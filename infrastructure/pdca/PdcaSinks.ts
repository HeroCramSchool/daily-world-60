/**
 * PDCA の外とのやりとり: git の変更履歴・失敗した run・GitHub Issue・Drive のレポート。
 * PDCA_DRY=1 のときは Issue を立てず、Drive にも書かず、内容を出力するだけにする。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { REPO_ROOT } from "./RegistryFile.js";

export const DRY = process.env.PDCA_DRY === "1";
const LABEL = "pdca";
export const WEEKLY_TITLE = "PDCA 週報";

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 本番に効く変更（Routine のプロンプト・描画・投稿・ワークフロー・台帳）の git 履歴。 */
export function gitChanges(start: string, end: string): string[] {
  try {
    const out = run("git", ["log", `--since=${start}T00:00:00Z`, `--until=${end}T23:59:59Z`, "--no-merges", "--format=%as %s", "--",
      "cron/", "remotion/src/", "remotion/prep-short.ts", "scripts/", ".github/workflows/", "content/maps/registry.json", "experiments/registry.json"]);
    // 中身に効かない変更（docs / ci / chore / test）と地図の投稿記録は外す
    return out.split("\n").map(s => s.trim()).filter(Boolean)
      .filter(s => !/^\S+ (map: posted |(docs|ci|chore|test)(\(|:))/.test(s));
  } catch (e) {
    console.warn(`[pdca] git log failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** 投稿系ワークフローの失敗（gh が使えるときだけ）。 */
export function failedRuns(start: string, end: string): string[] {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return [];
  const out: string[] = [];
  for (const wf of ["publish.yml", "map-short.yml"]) {
    try {
      const json = run("gh", ["run", "list", "--workflow", wf, "--status", "failure", "--created", `${start}..${end}`, "--limit", "30", "--json", "createdAt,displayTitle"]);
      for (const r of JSON.parse(json) as Array<{ createdAt: string; displayTitle: string }>) out.push(`${r.createdAt.slice(0, 10)} ${wf} 失敗（${r.displayTitle}）`);
    } catch (e) {
      console.warn(`[pdca] gh run list ${wf} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

function ensureLabel(): void {
  run("gh", ["label", "create", LABEL, "--color", "C2410C", "--description", "PDCA の判定・週報（自動）", "--force"]);
}

function findIssue(title: string): { number: number; state: string } | undefined {
  const json = run("gh", ["issue", "list", "--label", LABEL, "--state", "all", "--limit", "200", "--json", "number,title,state"]);
  return (JSON.parse(json) as Array<{ number: number; title: string; state: string }>).find(i => i.title === title);
}

/**
 * 判定待ち・停止の Issue。開いていれば本文を最新の数字に更新し、閉じていれば（オーナーが片付けた）立て直さない。
 */
export function upsertIssue(title: string, body: string): string {
  if (DRY) { console.log(`[pdca][dry] issue: ${title}\n${body}\n`); return "dry"; }
  ensureLabel();
  const existing = findIssue(title);
  if (existing && existing.state.toUpperCase() === "OPEN") {
    run("gh", ["issue", "edit", String(existing.number), "--body", body]);
    return `updated #${existing.number}`;
  }
  if (existing) return `closed #${existing.number}（立て直さない）`;
  const url = run("gh", ["issue", "create", "--title", title, "--label", LABEL, "--body", body]).trim();
  return `created ${url}`;
}

/** 「PDCA 週報」Issue に1週分をコメントする（無ければ作る）。同じ週の見出しのコメントがあれば書かない。 */
export function postWeekly(body: string, heading: string, force = false): string {
  if (DRY) { console.log(`[pdca][dry] weekly:\n${body}\n`); return "dry"; }
  ensureLabel();
  const found = findIssue(WEEKLY_TITLE);
  let n = found && found.state.toUpperCase() === "OPEN" ? found.number : undefined;
  if (!n) {
    const url = run("gh", ["issue", "create", "--title", WEEKLY_TITLE, "--label", LABEL, "--body", "毎週、施策の状況をここへ追記する（stats.yml が自動で書く）。"]).trim();
    n = Number(url.split("/").pop());
  }
  if (!force) {
    const comments = JSON.parse(run("gh", ["issue", "view", String(n), "--json", "comments"])) as { comments: Array<{ body: string }> };
    if (comments.comments.some(c => c.body.startsWith(heading))) return "exists";
  }
  run("gh", ["issue", "comment", String(n), "--body", body]);
  return `commented #${n}`;
}

/** Actions の実行画面の要約欄に出す。 */
export function stepSummary(markdown: string): void {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, `${markdown}\n`);
}
