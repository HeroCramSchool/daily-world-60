/**
 * PDCA の C: 判定。投稿7日後の再生数（views@7d）を、日ごとの塊で比べる。
 * 同じ日の動画はニュースの強さを共有していて独立でないので、区間は日単位で引き直して出す。
 * 同じ日の中で腕が分かれる施策（unit=video）は、比も同じ日どうしの差の平均で出す。
 */
import type { Experiment } from "./Experiment.js";
import { holds, parseRule, EARLY_VARS, type RuleVars } from "./Rule.js";

/** matured = 公開から7日たった（at7d が無ければスナップショットの欠け）。at48h = 投稿48時間後の再生（止める条件用）。 */
export type Row = { videoId: string; date: string; arm: string; at7d?: number; at48h?: number; matured?: boolean };
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
  /** 投稿48時間後の再生での腕ごとの本数と中央値（止める条件に48時間の数字を使う施策だけ）。 */
  arms48?: ArmSummary[];
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

/**
 * 日ごとに分けた比: 両方の腕がそろった日だけで「その日の treatment の対数平均 − control の対数平均」を出し、日で平均する。
 * 片方の腕しか無い日（割り付けで片寄った日・片側だけ比較から外れた日）は落ちるので、日の再生の大小が比に乗らない。
 */
export function stratifiedRatio(rows: Row[], treatment: string, control: string): number | undefined {
  const byDay = new Map<string, { t: number[]; c: number[] }>();
  for (const r of done(rows)) {
    const g = byDay.get(r.date) ?? { t: [], c: [] };
    if (r.arm === treatment) g.t.push(ln1p(r.at7d));
    else if (r.arm === control) g.c.push(ln1p(r.at7d));
    byDay.set(r.date, g);
  }
  const diffs = [...byDay.values()].filter(g => g.t.length && g.c.length).map(g => mean(g.t) - mean(g.c));
  return diffs.length ? Math.exp(mean(diffs)) : undefined;
}

/** 両方の腕に views@7d がある日の行だけ。日ごとに分けた比の区間を、比べられる日だけで引き直すのに使う。 */
function pairedDays(rows: Row[], treatment: string, control: string): Row[] {
  const d = done(rows);
  const daysOf = (arm: string) => new Set(d.filter(r => r.arm === arm).map(r => r.date));
  const t = daysOf(treatment), c = daysOf(control);
  return d.filter(r => (r.arm === treatment || r.arm === control) && t.has(r.date) && c.has(r.date));
}

type RatioStat = (rows: Row[], treatment: string, control: string) => number | undefined;

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

/** 日を単位に引き直すブートストラップの95%区間。stat は比の出し方（既定はまとめた比）。 */
export function clusterBootstrap(rows: Row[], treatment: string, control: string, stat: RatioStat = geoMeanRatio, iters = 2000, seed = 20261018): [number, number] | undefined {
  const d = done(rows).filter(r => r.arm === treatment || r.arm === control);
  const byDay = new Map<string, typeof d>();
  for (const r of d) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return undefined;
  const rand = rng(seed);
  const ratios: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: Row[] = [];
    // 同じ日を2回引いたら2日分として数える（日ごとの比で1日にまとまらないよう、引いた回ごとに日を付け替える）
    for (let k = 0; k < days.length; k++) sample.push(...byDay.get(days[Math.floor(rand() * days.length)])!.map(r => ({ ...r, date: String(k) })));
    const r = stat(sample, treatment, control);
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
  // 同じ日の中で腕が分かれる施策は、比と区間を日ごとに分けて出す。中央値（medRatio）は全期間をまとめたまま
  const byDay = e.unit === "video";
  const stat = byDay ? stratifiedRatio : geoMeanRatio;
  const ratioRows = byDay ? pairedDays(rows, treatment, control) : rows;
  const ratio = stat(ratioRows, treatment, control);
  const ci = clusterBootstrap(ratioRows, treatment, control, stat);
  const nT = summaries.find(s => s.arm === treatment)?.n ?? 0;
  const nC = summaries.find(s => s.arm === control)?.n ?? 0;
  const medT = summaries.find(s => s.arm === treatment)?.median;
  const medC = summaries.find(s => s.arm === control)?.median;
  const s48 = summarize(rows.map(r => ({ ...r, at7d: r.at48h })), [treatment, control]);
  const medT48 = s48[0].median, medC48 = s48[1].median;
  const vars: RuleVars = {
    ratio, lo: ci?.[0], hi: ci?.[1], n: Math.min(nT, nC), nT, nC, medT, medC,
    medRatio: medT !== undefined && medC !== undefined && medC > 0 ? medT / medC : undefined,
    nT48: s48[0].n,
    medRatio48: medT48 !== undefined && medC48 !== undefined && medC48 > 0 ? medT48 / medC48 : undefined,
  };
  const stopIf = e.decide?.stopIf;
  const uses48 = !!stopIf && parseRule(stopIf).flat().some(c => EARLY_VARS.includes(c.v));
  const base = { treatment, control, ratio, lo: ci?.[0], hi: ci?.[1], arms: summaries, ...(uses48 ? { arms48: s48 } : {}) };

  if (stopIf && holds(stopIf, vars)) return { ...base, state: "stop", reason: `停止条件に当たった: ${stopIf}` };
  if (!due) return { ...base, state: "collecting", reason: notDue };
  const minN = e.decide?.minN ?? 1;
  if (Math.min(nT, nC) < minN) return { ...base, state: "inconclusive", reason: `本数が足りない（${treatment} ${nT}本 / ${control} ${nC}本、必要 ${minN}本）` };
  const adoptIf = e.decide?.adoptIf ?? defaults.adoptIf;
  const rejectIf = e.decide?.rejectIf ?? defaults.rejectIf;
  if (holds(adoptIf, vars)) return { ...base, state: "adopt", reason: `採用の基準を満たした: ${adoptIf}` };
  if (holds(rejectIf, vars)) return { ...base, state: "reject", reason: `不採用の基準に当たった: ${rejectIf}` };
  return { ...base, state: "inconclusive", reason: `どちらの基準にも当たらない（採用: ${adoptIf} / 不採用: ${rejectIf}）` };
}
