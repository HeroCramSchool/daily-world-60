/**
 * PDCA の C: 判定。投稿7日後の再生数（views@7d）を、日ごとの塊で比べる。
 * 同じ日の動画はニュースの強さを共有していて独立でないので、区間は日単位で引き直して出す。
 */
import type { Experiment } from "./Experiment.js";
import { holds, type RuleVars } from "./Rule.js";

/** matured = 公開から7日たった（at7d が無ければスナップショットの欠け）。 */
export type Row = { videoId: string; date: string; arm: string; at7d?: number; matured?: boolean };
export type VerdictState = "collecting" | "adopt" | "reject" | "inconclusive" | "stop" | "manual";
export type ArmSummary = { arm: string; n: number; median?: number; geoMean?: number };
export type Verdict = {
  state: VerdictState;
  reason: string;
  treatment?: string;
  control?: string;
  ratio?: number;
  lo?: number;
  hi?: number;
  arms: ArmSummary[];
  /** observational（順位ごとなど）: 日の合計に占める割合の平均。 */
  shares?: Record<string, number>;
};

const ln1p = (x: number) => Math.log(1 + Math.max(0, x));
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function done(rows: Row[]): Array<Row & { at7d: number }> {
  return rows.filter((r): r is Row & { at7d: number } => typeof r.at7d === "number");
}

export function summarize(rows: Row[], arms: string[]): ArmSummary[] {
  const d = done(rows);
  return arms.map(arm => {
    const xs = d.filter(r => r.arm === arm).map(r => r.at7d);
    return { arm, n: xs.length, median: median(xs), geoMean: xs.length ? Math.exp(mean(xs.map(ln1p))) - 1 : undefined };
  });
}

/** 対数の平均の比（treatment / control）。 */
export function geoMeanRatio(rows: Row[], treatment: string, control: string): number | undefined {
  const d = done(rows);
  const t = d.filter(r => r.arm === treatment).map(r => ln1p(r.at7d));
  const c = d.filter(r => r.arm === control).map(r => ln1p(r.at7d));
  if (!t.length || !c.length) return undefined;
  return Math.exp(mean(t) - mean(c));
}

/** 再現できる乱数（mulberry32）。区間が実行ごとに変わらないようにする。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 日を単位に引き直すブートストラップの95%区間。 */
export function clusterBootstrap(rows: Row[], treatment: string, control: string, iters = 2000, seed = 20261018): [number, number] | undefined {
  const d = done(rows).filter(r => r.arm === treatment || r.arm === control);
  const byDay = new Map<string, typeof d>();
  for (const r of d) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return undefined;
  const rand = rng(seed);
  const ratios: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: Row[] = [];
    for (let k = 0; k < days.length; k++) sample.push(...byDay.get(days[Math.floor(rand() * days.length)])!);
    const r = geoMeanRatio(sample, treatment, control);
    if (r !== undefined && Number.isFinite(r)) ratios.push(r);
  }
  if (ratios.length < iters * 0.5) return undefined;
  ratios.sort((a, b) => a - b);
  const q = (p: number) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor(p * ratios.length)))];
  return [q(0.025), q(0.975)];
}

/** 日ごとの合計に占める各腕の割合の平均（全部の腕がそろった日だけ）。 */
export function dailyShares(rows: Row[], arms: string[]): Record<string, number> | undefined {
  const d = done(rows);
  const byDay = new Map<string, typeof d>();
  for (const r of d) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const acc: Record<string, number[]> = Object.fromEntries(arms.map(a => [a, []]));
  for (const rs of byDay.values()) {
    if (!arms.every(a => rs.some(r => r.arm === a))) continue;
    const total = rs.reduce((s, r) => s + r.at7d, 0);
    if (total <= 0) continue;
    for (const a of arms) acc[a].push(rs.filter(r => r.arm === a).reduce((s, r) => s + r.at7d, 0) / total);
  }
  if (!arms.some(a => acc[a].length)) return undefined;
  return Object.fromEntries(arms.map(a => [a, acc[a].length ? mean(acc[a]) : NaN]));
}

export type Defaults = { adoptIf: string; rejectIf: string };

export function evaluate(e: Experiment, rows: Row[], today: string, defaults: Defaults): Verdict {
  const arms = e.arms ?? [];
  const summaries = summarize(rows, arms);
  const decideOn = e.window?.decideOn ?? "9999-12-31";
  // 判定日でも、期間内にまだ7日たっていない動画が残っていれば待つ（欠けた数字で決めない）
  const waiting = rows.filter(r => r.at7d === undefined && r.matured === false).length;
  const due = today >= decideOn && waiting === 0;
  const notDue = today >= decideOn ? `判定日を過ぎたが、まだ7日たっていない動画が${waiting}本ある` : `判定日 ${decideOn} まで集計中`;

  if (e.decide?.manual || e.design === "observational") {
    return {
      state: due ? "manual" : "collecting",
      reason: due ? "判定日に来た。数字を見てオーナーが決める" : notDue,
      arms: summaries,
      shares: dailyShares(rows, arms),
    };
  }

  const control = e.control ?? arms[0];
  const treatment = arms.find(a => a !== control) ?? arms[1];
  const ratio = geoMeanRatio(rows, treatment, control);
  const ci = clusterBootstrap(rows, treatment, control);
  const nT = summaries.find(s => s.arm === treatment)?.n ?? 0;
  const nC = summaries.find(s => s.arm === control)?.n ?? 0;
  const medT = summaries.find(s => s.arm === treatment)?.median;
  const medC = summaries.find(s => s.arm === control)?.median;
  const vars: RuleVars = {
    ratio, lo: ci?.[0], hi: ci?.[1], n: Math.min(nT, nC), nT, nC, medT, medC,
    medRatio: medT !== undefined && medC !== undefined && medC > 0 ? medT / medC : undefined,
  };
  const base = { treatment, control, ratio, lo: ci?.[0], hi: ci?.[1], arms: summaries };

  if (e.decide?.stopIf && holds(e.decide.stopIf, vars)) return { ...base, state: "stop", reason: `停止条件に当たった: ${e.decide.stopIf}` };
  if (!due) return { ...base, state: "collecting", reason: notDue };
  const minN = e.decide?.minN ?? 1;
  if (Math.min(nT, nC) < minN) return { ...base, state: "inconclusive", reason: `本数が足りない（${treatment} ${nT}本 / ${control} ${nC}本、必要 ${minN}本）` };
  const adoptIf = e.decide?.adoptIf ?? defaults.adoptIf;
  const rejectIf = e.decide?.rejectIf ?? defaults.rejectIf;
  if (holds(adoptIf, vars)) return { ...base, state: "adopt", reason: `採用の基準を満たした: ${adoptIf}` };
  if (holds(rejectIf, vars)) return { ...base, state: "reject", reason: `不採用の基準に当たった: ${rejectIf}` };
  return { ...base, state: "inconclusive", reason: `どちらの基準にも当たらない（採用: ${adoptIf} / 不採用: ${rejectIf}）` };
}
