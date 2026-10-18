/**
 * PDCA の C と A の材料: 施策ごとの途中経過・判定・交絡の候補を出し、レポートと週報の文章にする。
 * 入出力（Drive・GitHub・git）は持たない。必要なものは Ctx で受け取る。
 */
import { isLive, LABEL5, type Experiment, type Registry } from "../../domain/experiment/Experiment.js";
import { evaluate, type Row, type Verdict } from "../../domain/experiment/Verdict.js";
import { minDetectableRatio2 } from "../../domain/experiment/Power.js";

export type VideoFact = {
  videoId: string;
  title: string;
  publishedAt: string;
  scriptDate?: string;
  format?: string;
  variant?: string;
  rank?: number;
  index?: number;
  exp?: string[];
  arm?: Record<string, string>;
  /** 投稿7日後の再生数。7日たっていない動画と、スナップショットが欠けた動画は undefined。 */
  at7d?: number;
  /** 公開から7日（168時間）たったか。 */
  matured: boolean;
};

export type Ctx = {
  today: string;
  gitChanges: (start: string, end: string) => string[];
  failedRuns: (start: string, end: string) => string[];
  /** 本編を投稿した台本日（posted-ledger.json から）。無ければ stats-history の動画から推す（RSS の遅れで取りこぼすことがある）。 */
  postedNewsDays?: Set<string>;
};

export type Phase = "collecting" | "decide" | "stop";
export type Readout = {
  exp: Experiment; verdict: Verdict; phase: Phase; rows: number;
  /** 7日たっていない本数 */ pending: number;
  /** 7日たったのに views@7d が出せない本数（スナップショットの欠け） */ missing: number;
  /** 台帳に記録が無く（format・台本日が無い）対象から外した本数 */ unlinked: number;
  confounds: string[]; mde?: number;
};

export const dateOf = (v: VideoFact) => v.scriptDate ?? v.publishedAt.slice(0, 10);

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * 施策の対象になる動画を、腕つきの行にする（期間・format・腕で絞る）。
 * format が無い動画は本編とみなすが、本編以外も比べる施策では、台帳に記録の無い動画（台本日も無い）を外す
 * （台帳への追記に失敗した地図が本編の群に混ざらないように）。
 */
export function rowsFor(e: Experiment, videos: VideoFact[]): Row[] {
  return rowsAndUnlinked(e, videos).rows;
}

export function rowsAndUnlinked(e: Experiment, videos: VideoFact[]): { rows: Row[]; unlinked: number } {
  const population = e.population ?? ["news"];
  const strict = population.some(p => p !== "news") || (e.armSource?.by === "field" && e.armSource.field === "format");
  const out: Row[] = [];
  let unlinked = 0;
  for (const v of videos) {
    if (strict && v.format === undefined && v.scriptDate === undefined) { unlinked++; continue; }
    const fmt = v.format ?? "news";
    if (!population.includes(fmt)) continue;
    const date = dateOf(v);
    if (e.window && (date < e.window.start || date > e.window.end)) continue;
    let arm: string | undefined;
    if (e.armSource?.by === "hash") arm = v.exp?.includes(e.id) ? v.arm?.[e.id] : undefined;
    else if (e.armSource?.by === "field") {
      const f = e.armSource.field;
      const raw = f === "format" ? fmt : f === "variant" ? v.variant : f === "rank" ? v.rank : v.index;
      arm = raw === undefined || raw === null ? undefined : String(raw);
    }
    if (!arm || !(e.arms ?? []).includes(arm)) continue;
    out.push({ videoId: v.videoId, date, arm, at7d: v.at7d, matured: v.matured });
  }
  return { rows: out, unlinked };
}

/** 本編が1本も出なかった日（期間の中で、昨日まで）。 */
export function zeroPostDays(videos: VideoFact[], start: string, end: string, today: string, postedNewsDays?: Set<string>): string[] {
  const posted = postedNewsDays ?? new Set(videos.filter(v => (v.format ?? "news") === "news").map(dateOf));
  const last = end < today ? end : addDays(today, -1);
  // 台帳は古い日を刈り込む（56日）。記録の無い古い日を「0本」と誤って数えない
  const oldest = postedNewsDays?.size ? [...postedNewsDays].sort()[0] : start;
  const from = start > oldest ? start : oldest;
  const out: string[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) if (!posted.has(d)) out.push(d);
  return out;
}

export function confounds(e: Experiment, others: Experiment[], videos: VideoFact[], ctx: Ctx): string[] {
  if (!e.window) return [];
  const { start } = e.window;
  const end = e.window.end < ctx.today ? e.window.end : ctx.today;
  return [
    ...ctx.gitChanges(start, end).map(s => `変更: ${s}`),
    ...zeroPostDays(videos, start, end, ctx.today, ctx.postedNewsDays).map(d => `事故: ${d} 本編0本`),
    ...ctx.failedRuns(start, end).map(s => `事故: ${s}`),
    ...others.filter(o => o.id !== e.id && o.status === "running" && o.window
      && o.window.start <= end && start <= o.window.end).map(o => `同時に実行中: ${o.id}`),
  ];
}

export function readoutExperiments(reg: Registry, videos: VideoFact[], ctx: Ctx): Readout[] {
  const live = reg.experiments.filter(e => e.status === "running" || e.status === "ready");
  return live.map(e => {
    const { rows, unlinked } = rowsAndUnlinked(e, videos);
    const verdict = evaluate(e, rows, ctx.today, reg.defaultDecide);
    const phase: Phase = verdict.state === "stop" ? "stop" : verdict.state === "collecting" ? "collecting" : "decide";
    // 見分けられる最小の差: 動画ごとの割り付けなら本数、日ごとなら日数で数える（同じ日の動画は独立でない）
    const sizes = (e.arms ?? []).map(a => {
      const done = rows.filter(r => r.arm === a && r.at7d !== undefined);
      return e.unit === "video" ? done.length : new Set(done.map(r => r.date)).size;
    });
    const mde = sizes.length === 2 ? minDetectableRatio2(sizes[0], sizes[1], reg.sigma) : undefined;
    return {
      exp: e, verdict, phase, rows: rows.length,
      pending: rows.filter(r => r.at7d === undefined && !r.matured).length,
      missing: rows.filter(r => r.at7d === undefined && r.matured).length,
      unlinked, confounds: confounds(e, reg.experiments, videos, ctx), mde: mde !== undefined && Number.isFinite(mde) ? mde : undefined,
    };
  });
}

const f2 = (x?: number) => (x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(2));
const f0 = (x?: number) => (x === undefined || !Number.isFinite(x) ? "-" : String(Math.round(x * 10) / 10));
const pct = (x?: number) => (x === undefined || !Number.isFinite(x) ? "-" : `${Math.round(x * 100)}%`);

const STATE_JA: Record<string, string> = {
  collecting: "集計中", adopt: "採用の基準を満たした", reject: "不採用の基準に当たった",
  inconclusive: "判定不能", stop: "停止条件に当たった", manual: "判定日（オーナーが決める）",
};

export function readoutLines(r: Readout, sigma: number): string[] {
  const v = r.verdict;
  const arms = v.arms.map(a => `${a.arm} ${a.n}本（中央値 ${f0(a.median)}）`).join(" / ");
  const lines = [
    `- 状態: **${STATE_JA[v.state] ?? v.state}** — ${v.reason}`,
    v.ratio !== undefined
      ? `- 比（${v.treatment}/${v.control}）: ${f2(v.ratio)} [95%区間 ${f2(v.lo)}〜${f2(v.hi)}] · ${arms}`
      : `- ${arms || "対象の動画はまだ無い"}`,
  ];
  if (v.shares) lines.push(`- 日の合計に占める割合: ${Object.entries(v.shares).map(([k, s]) => `${k} ${pct(s)}`).join(" / ")}`);
  if (r.mde !== undefined) lines.push(`- この本数で見分けられる最小の差: ${r.mde.toFixed(1)}倍（σ=${sigma}・${r.exp.unit === "video" ? "本数" : "日数"}で計算）`);
  if (r.pending) lines.push(`- まだ7日たっていない動画: ${r.pending}本`);
  if (r.missing) lines.push(`- 7日たったが記録が欠けて数えられない動画: ${r.missing}本`);
  if (r.unlinked) lines.push(`- 台帳に記録が無く対象から外した動画: ${r.unlinked}本`);
  if (r.exp.window) lines.push(`- 期間: ${r.exp.window.start}〜${r.exp.window.end} · 判定日 ${r.exp.window.decideOn}`);
  if (r.confounds.length) lines.push(`- 同じ期間の変更・事故（交絡の候補）:`, ...r.confounds.slice(0, 12).map(c => `  - ${c}`), ...(r.confounds.length > 12 ? [`  - ほか ${r.confounds.length - 12} 件`] : []));
  return lines;
}

function plan5Lines(e: Experiment): string[] {
  if (!e.plan5) return [];
  return (Object.keys(LABEL5) as Array<keyof typeof LABEL5>).map(k => `- ${LABEL5[k]}: ${e.plan5![k]}`);
}

export const NEXT_STEP = "experiments/registry.json の status と decision（結果・やること・学び）を書いて PR にし、オーナーがマージする。下書きは Claude に頼める。";

export function renderReport(reg: Registry, readouts: Readout[], today: string): string {
  const section = (title: string, rs: Readout[], withPlan: boolean) => rs.length
    ? [`## ${title}`, "", ...rs.flatMap(r => [`### ${r.exp.id} — ${r.exp.title}`, ...readoutLines(r, reg.sigma), ...(withPlan ? ["", "<details><summary>5点</summary>", "", ...plan5Lines(r.exp), "", "</details>"] : []), ""])]
    : [`## ${title}`, "", "- なし", ""];
  const ideas = reg.experiments.filter(e => e.status === "idea" || e.status === "draft");
  const closed = reg.experiments.filter(e => e.decision).sort((a, b) => b.decision!.on.localeCompare(a.decision!.on)).slice(0, 5);
  return [
    `# DW60 施策レポート（自動・${today}）`,
    "",
    "判定は投稿7日後の再生数（views@7d）の幾何平均の比で行う。95%区間は日ごとに引き直したブートストラップ。基準は台帳に結果を見る前に書いたもの。",
    "",
    ...section("判定待ち（オーナーが決める）", readouts.filter(r => r.phase === "decide"), true),
    ...(readouts.some(r => r.phase === "decide") ? [`次にやること: ${NEXT_STEP}`, ""] : []),
    ...section("停止条件に当たった", readouts.filter(r => r.phase === "stop"), true),
    ...section("集計中", readouts.filter(r => r.phase === "collecting"), false),
    "## 候補・準備中",
    "",
    ...(ideas.length ? ideas.map(e => `- ${e.id}（${e.status}）— ${e.title}${e.source ? `（${e.source}）` : ""}`) : ["- なし"]),
    "",
    "## 決まった施策（直近5件）",
    "",
    ...(closed.length ? closed.map(e => `- ${e.decision!.on} ${e.id}: ${e.decision!.learning} → ${e.decision!.action}`) : ["- なし"]),
    "",
  ].join("\n");
}

/** 判定待ち・停止のとき1件だけ立てる Issue。集計中は立てない。 */
export function issueFor(r: Readout, sigma: number): { title: string; body: string } | undefined {
  if (r.phase === "collecting") return undefined;
  const label = r.phase === "stop" ? "停止条件" : "判定待ち";
  return {
    title: `[PDCA] ${r.exp.id}: ${label}`,
    body: [`${r.exp.title}`, "", ...readoutLines(r, sigma), "", "5点:", ...plan5Lines(r.exp), "", `次にやること: ${NEXT_STEP}`].join("\n"),
  };
}

/** その週の月曜（UTC）。週報の見出しと重複防止に使う。 */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export const weeklyHeading = (day: string) => `## PDCA 週報 · ${mondayOf(day)} の週`;

export function weeklySummary(reg: Registry, readouts: Readout[], videos: VideoFact[], ctx: Ctx): string {
  const weekStart = addDays(ctx.today, -7);
  const soon = addDays(ctx.today, 14);
  const decide = readouts.filter(r => r.phase !== "collecting");
  const upcoming = reg.experiments.filter(e => e.status === "running" && e.window && e.window.decideOn > ctx.today && e.window.decideOn <= soon);
  const changes = ctx.gitChanges(weekStart, ctx.today);
  const zero = zeroPostDays(videos, weekStart, ctx.today, ctx.today, ctx.postedNewsDays);
  const failed = ctx.failedRuns(weekStart, ctx.today);
  const ideas = reg.experiments.filter(e => e.status === "idea" || e.status === "draft");
  return [
    weeklyHeading(ctx.today),
    "",
    `実行中 ${reg.experiments.filter(e => e.status === "running").length} · 判定待ち ${decide.length} · 候補 ${ideas.length} · 決まった施策 ${reg.experiments.filter(e => e.decision).length}`,
    "",
    "**オーナーが決めること**",
    ...(decide.length ? decide.map(r => `- ${r.exp.id}: ${STATE_JA[r.verdict.state] ?? r.verdict.state}（${r.verdict.reason}）`) : ["- なし"]),
    "",
    "**2週間以内の判定日**",
    ...(upcoming.length ? upcoming.map(e => `- ${e.window!.decideOn} ${e.id} — ${e.title}`) : ["- なし"]),
    "",
    "**この1週間の変更・事故**",
    ...([...changes.map(c => `- 変更: ${c}`), ...zero.map(d => `- 事故: ${d} 本編0本`), ...failed.map(f => `- 事故: ${f}`)].slice(0, 20)),
    ...(changes.length + zero.length + failed.length === 0 ? ["- なし"] : []),
    "",
    "**候補**",
    ...(ideas.length ? ideas.map(e => `- ${e.id}（${e.status}）— ${e.title}`) : ["- なし"]),
    "",
    `詳しくは Drive の experiments-report.md。台帳は experiments/registry.json、学びは experiments/learnings.md。`,
  ].join("\n");
}

export { isLive };
