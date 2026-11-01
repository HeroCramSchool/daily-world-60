/**
 * 本編を解説形式（explainer）で作るか、今の形式（legacy）で作るか。外部依存なし。
 * 台本作り（write-explainers）・絵の取得（fetch-broll）・描画（prep-short）が同じ答えを使う。
 */
import type { Experiment } from "../experiment/Experiment.js";
import { activeHashExperiments, assignArm, type ArmRecord } from "../experiment/Assignment.js";

export type Style = "explainer" | "legacy";

export type ExplainerStatus =
  | "ok"
  | "not_assigned"
  | "disabled"
  | "cap"
  | "api_error"
  | "no_docs"
  | "check_failed"
  | "refuted"
  | "refusal"
  // その本の呼び出しが1回でも返った後に止まった（締め切り・予算切れ・max_tokens・API の誤りなど）。中身で決まりうるので比較から外さない
  | "incomplete";

export type ExplainerStatusEntry = { status: ExplainerStatus; code: string; errors?: string[]; costUsd?: number };
/** $OUT_DIR/explainer-status.json。キーは投稿順 (story.index)。 */
export type ExplainerStatusFile = Record<string, ExplainerStatusEntry>;

/**
 * 解説形式を試みなかった理由が台本の中身と無関係なもの（キー未設定・費用の上限・API の障害）。
 * この本は新旧の比較から外す。中身が原因で今の形式に戻った本（照合・反証の不合格、拒否）は外さない。
 */
export const INFRA_FAILURES: readonly ExplainerStatus[] = ["disabled", "cap", "api_error"];

export const STATUS_FILE = "explainer-status.json";
export const storyboardFile = (index: number, code: string) => `storyboard-${index}-${code.toLowerCase()}.json`;

const hasExplainerArm = (e: Experiment) => (e.arms ?? []).includes("explainer");

/** その日に新旧を割り付けている施策。 */
export function explainerExperiment(experiments: Experiment[], date: string): Experiment | undefined {
  return activeHashExperiments(experiments, "news", date).find(hasExplainerArm);
}

export type StyleDecision = { style: Style; by: "override" | "experiment" | "adopted" | "default"; expId?: string };

/**
 * 手動の指定 (EXPLAINER=on|off) > 動いている施策の腕 > 採用済みなら explainer > legacy。
 */
export function styleFor(experiments: Experiment[], date: string, index: number, override?: string): StyleDecision {
  const ov = override?.trim().toLowerCase();
  const e = explainerExperiment(experiments, date);
  if (ov === "on" || ov === "explainer") return { style: "explainer", by: "override", expId: e?.id };
  if (ov === "off" || ov === "legacy") return { style: "legacy", by: "override", expId: e?.id };
  if (e) return { style: assignArm(e, date, index) === "explainer" ? "explainer" : "legacy", by: "experiment", expId: e.id };
  if (experiments.some(x => x.status === "adopted" && hasExplainerArm(x))) return { style: "explainer", by: "adopted" };
  return { style: "legacy", by: "default" };
}

export type StyledArmRecord = ArmRecord & { style: Style };

/**
 * 台帳に写す記録へ、実際に描いた形式を足す。腕は割り付けたまま残す（中身が原因の差し戻しも新形式の腕に数える）。
 * ただし解説形式に割り付けたのに INFRA_FAILURES で試みなかった本と、手動の指定で描いた本は、この施策から外す。
 */
export function finalizeArmRecord(rec: ArmRecord, decision: StyleDecision, status: ExplainerStatus | undefined, rendered: Style): StyledArmRecord {
  const drop = decision.expId && (
    decision.by === "override" ||
    (decision.style === "explainer" && (status === undefined || INFRA_FAILURES.includes(status)))
  );
  if (!drop || !rec.exp || !rec.arm) return { ...rec, style: rendered };
  const exp = rec.exp.filter(id => id !== decision.expId);
  const arm = Object.fromEntries(Object.entries(rec.arm).filter(([id]) => id !== decision.expId));
  return exp.length ? { variant: rec.variant, exp, arm, style: rendered } : { variant: rec.variant, style: rendered };
}
