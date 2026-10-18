/**
 * 施策台帳 (experiments/registry.json) の型と検査。外部依存なし。
 * PDCA の P: 施策は始める前に台帳へ登録し、5点と判定の決まりを結果を見る前に書く。
 */
import { parseRule } from "./Rule.js";

export type Status = "idea" | "draft" | "running" | "ready" | "adopted" | "rejected" | "stopped";
export type Design = "randomized" | "comparison" | "observational";
export type Lane = "news" | "hook" | "map" | "overnight";
export type Unit = "video" | "day" | "night";
export type ArmField = "variant" | "rank" | "index" | "format";
/** hash = 台帳の exp/arm（assignArm で割り付け）。field = 動画の既存の項目をそのまま腕にする。 */
export type ArmSource = { by: "hash" } | { by: "field"; field: ArmField };

export type Plan5 = { konkyo: string; kasetsu: string; kitai: string; hakarikata: string; yameru: string };
export type Window = { start: string; end: string; decideOn: string };
export type DecideRule = { minN: number; adoptIf?: string; rejectIf?: string; stopIf?: string; manual?: boolean };
export type Decision = {
  result: "adopted" | "rejected" | "inconclusive" | "stopped";
  action: string;
  by: string;
  on: string;
  learning: string;
};
export type VerdictSnapshot = { state: string; ratio?: number; lo?: number; hi?: number; on: string };

export type Experiment = {
  id: string;
  title: string;
  status: Status;
  design?: Design;
  lane?: Lane;
  unit?: Unit;
  arms?: string[];
  control?: string;
  armSource?: ArmSource;
  /** 対象にする動画の format。省略時は ["news"]（format 未記入の本編を含む）。 */
  population?: string[];
  plan5?: Plan5;
  window?: Window;
  decide?: DecideRule;
  /** 1群あたりの見込み本数（見分けられる最小の差の計算に使う）。 */
  expectedPerArm?: number;
  verdict?: VerdictSnapshot;
  decision?: Decision;
  source?: string;
  notes?: string;
};

export type Registry = {
  version: 1;
  /** log(再生+1) の標準偏差。見分けられる最小の差の計算に使う。 */
  sigma: number;
  sigmaNote?: string;
  defaultDecide: { adoptIf: string; rejectIf: string };
  experiments: Experiment[];
};

const STATUSES: Status[] = ["idea", "draft", "running", "ready", "adopted", "rejected", "stopped"];
const DESIGNS: Design[] = ["randomized", "comparison", "observational"];
const LANES: Lane[] = ["news", "hook", "map", "overnight"];
const UNITS: Unit[] = ["video", "day", "night"];
const FIELDS: ArmField[] = ["variant", "rank", "index", "format"];
const CLOSED: Status[] = ["adopted", "rejected", "stopped"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isClosed = (e: Experiment) => CLOSED.includes(e.status);
export const isLive = (e: Experiment) => e.status === "draft" || e.status === "running" || e.status === "ready";

/** 同じ枠を乱数で割り付ける施策が、期間の重なる形で同時に生きていれば true。 */
export function conflicts(a: Experiment, b: Experiment): boolean {
  if (a.id === b.id || !a.lane || a.lane !== b.lane) return false;
  if (a.armSource?.by !== "hash" || b.armSource?.by !== "hash") return false;
  if (!isLive(a) || !isLive(b) || !a.window || !b.window) return false;
  return a.window.start <= b.window.end && b.window.start <= a.window.end;
}

export type Check = { errors: string[]; warnings: string[] };

export function validateRegistry(reg: Registry): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (reg.version !== 1) errors.push(`version は 1 にする (今: ${reg.version})`);
  if (!(reg.sigma > 0)) errors.push("sigma が正の数でない");
  for (const k of ["adoptIf", "rejectIf"] as const) {
    try { parseRule(reg.defaultDecide?.[k] ?? ""); } catch (e) { errors.push(`defaultDecide.${k}: ${(e as Error).message}`); }
  }
  const seen = new Set<string>();
  for (const e of reg.experiments ?? []) {
    const p = (m: string) => `${e.id ?? "?"}: ${m}`;
    if (!e.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) errors.push(p("id は英小文字・数字・ハイフンだけにする"));
    if (seen.has(e.id)) errors.push(p("id が重複している"));
    seen.add(e.id);
    if (!e.title) errors.push(p("title が無い"));
    if (!STATUSES.includes(e.status)) { errors.push(p(`status が不正: ${e.status}`)); continue; }
    if (e.status === "idea") continue;

    if (!e.design || !DESIGNS.includes(e.design)) errors.push(p("design が無いか不正"));
    if (!e.lane || !LANES.includes(e.lane)) errors.push(p("lane が無いか不正"));
    if (!e.unit || !UNITS.includes(e.unit)) errors.push(p("unit が無いか不正"));
    if (!e.arms || e.arms.length < 2) errors.push(p("arms は2つ以上"));
    else if (!e.control || !e.arms.includes(e.control)) errors.push(p("control が arms に無い"));
    if (!e.armSource) errors.push(p("armSource が無い"));
    else if (e.armSource.by === "field" && !FIELDS.includes(e.armSource.field)) errors.push(p(`armSource.field が不正: ${e.armSource.field}`));
    if (e.design === "randomized" && e.armSource?.by === "field") warnings.push(p("randomized なのに armSource が field（乱数で割り付けていない）"));
    if (e.design !== "observational" && !e.decide?.manual && (e.arms?.length ?? 0) !== 2) errors.push(p("比で判定する施策は腕を2つにする（3つ以上は observational か manual）"));
    if (!isClosed(e) && e.window && e.window.decideOn < addDaysStr(e.window.end, 8)) warnings.push(p("decideOn は end の8日後以降にする（最終日の動画が7日たつのを待つ）"));

    const plan = e.plan5;
    for (const k of ["konkyo", "kasetsu", "kitai", "hakarikata", "yameru"] as const) {
      if (!plan?.[k]?.trim()) errors.push(p(`plan5.${k}（${LABEL5[k]}）が空`));
    }
    const w = e.window;
    if (!w || !DATE_RE.test(w.start) || !DATE_RE.test(w.end) || !DATE_RE.test(w.decideOn)) errors.push(p("window の日付が YYYY-MM-DD でない"));
    else if (!(w.start <= w.end && w.end <= w.decideOn)) errors.push(p("window は start <= end <= decideOn にする"));

    const d = e.decide;
    if (!d || !(d.minN >= 1)) errors.push(p("decide.minN が無い"));
    else if (!d.manual) {
      if (!d.adoptIf && !reg.defaultDecide?.adoptIf) errors.push(p("decide.adoptIf が無い"));
      for (const k of ["adoptIf", "rejectIf", "stopIf"] as const) {
        if (d[k]) try { parseRule(d[k]!); } catch (err) { errors.push(p(`decide.${k}: ${(err as Error).message}`)); }
      }
    } else if (e.design !== "observational") warnings.push(p("manual 判定は observational 以外では避ける"));

    if (isClosed(e)) {
      const dec = e.decision;
      if (!dec) errors.push(p("終わった施策に decision が無い"));
      else {
        if (!dec.by || !dec.on || !DATE_RE.test(dec.on)) errors.push(p("decision.by / decision.on が無い"));
        if (!dec.learning?.trim()) errors.push(p("decision.learning（学び）が空"));
        if (!dec.action?.trim()) errors.push(p("decision.action が空"));
      }
    } else if (e.decision) warnings.push(p("終わっていないのに decision がある"));
  }
  const live = (reg.experiments ?? []).filter(isLive);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    if (conflicts(live[i], live[j])) errors.push(`${live[i].id} と ${live[j].id}: 同じ枠（${live[i].lane}）を同じ期間に乱数で割り付けている`);
  }
  return { errors, warnings };
}

const addDaysStr = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export const LABEL5: Record<keyof Plan5, string> = {
  konkyo: "根拠の数字", kasetsu: "仮説", kitai: "期待する効果", hakarikata: "測り方", yameru: "やめる条件",
};

/** 決まった施策の学び（learnings.md と winning-patterns.md の「確定した学び」に載せる）。 */
export function learningsOf(reg: Registry): Array<{ id: string; lane?: Lane; on: string; result: string; learning: string; action: string }> {
  return (reg.experiments ?? [])
    .filter(e => isClosed(e) && e.decision)
    .map(e => ({ id: e.id, lane: e.lane, on: e.decision!.on, result: e.decision!.result, learning: e.decision!.learning, action: e.decision!.action }))
    .sort((a, b) => b.on.localeCompare(a.on) || a.id.localeCompare(b.id));
}

export function learningsMarkdown(reg: Registry): string {
  const rows = learningsOf(reg);
  const RESULT: Record<string, string> = { adopted: "採用", rejected: "不採用", inconclusive: "判定不能", stopped: "停止" };
  return [
    "# 確定した学び（施策台帳から自動生成）",
    "",
    "このファイルは `npm run pdca -- learnings` が experiments/registry.json から作る。手で直さない。",
    "",
    ...(rows.length
      ? rows.map(r => `- ${r.on} ${r.id}（${RESULT[r.result] ?? r.result}）: ${r.learning} → ${r.action}`)
      : ["- まだ無い"]),
    "",
  ].join("\n");
}
