/**
 * PDCA の D: 割り付け。台帳の施策・台本日・投稿順から、決まった腕を返す。
 * 誰が何度呼んでも同じ腕になる（描画の prep-short と台帳の publish-all が別々に呼ぶ）。
 * 日付の偶奇は使わない（2026-10-18 の分析で、A/B 前でも偶数日が 1.39 倍と偏っていた）。
 */
import type { Experiment, Lane } from "./Experiment.js";

/** FNV-1a 32bit + murmur3 の仕上げ。外部依存なしで偏りの少ない整数にする。 */
export function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function inWindow(e: Experiment, date: string): boolean {
  return Boolean(e.window && date >= e.window.start && date <= e.window.end);
}

/** 乱数で割り付ける施策で、その日に動いているもの。 */
export function activeHashExperiments(experiments: Experiment[], lane: Lane, date: string): Experiment[] {
  return experiments.filter(e => e.status === "running" && e.lane === lane && e.armSource?.by === "hash" && inWindow(e, date));
}

export function assignArm(e: Experiment, date: string, index: number): string {
  const arms = e.arms ?? [];
  if (!arms.length) throw new Error(`${e.id}: arms が無い`);
  if (e.status !== "running" || !inWindow(e, date)) return e.control ?? arms[0];
  const key = e.unit === "video" ? `${e.id}|${date}|${index}` : `${e.id}|${date}`;
  return arms[hash32(key) % arms.length];
}

/** 投稿した動画が入った施策と腕（台帳 posted-ledger.json に残す）。 */
export function armsFor(experiments: Experiment[], lanes: Lane[], date: string, index: number): { exp: string[]; arm: Record<string, string> } {
  const exp: string[] = [];
  const arm: Record<string, string> = {};
  for (const lane of lanes) {
    for (const e of activeHashExperiments(experiments, lane, date)) {
      exp.push(e.id);
      arm[e.id] = assignArm(e, date, index);
    }
  }
  return { exp, arm };
}

export type HookLayout = "top" | "legacy";

/**
 * 1フレーム目のレイアウト。手動の指定 > 動いている hook 施策の腕 > legacy。
 * 冒頭A/B（hook-layout-2026-10）は 2026-10-18 に判定不能で終了し、legacy に固定した。
 */
export function hookLayoutFor(experiments: Experiment[], date: string, index: number, override?: string): HookLayout {
  if (override === "top" || override === "legacy") return override;
  const e = activeHashExperiments(experiments, "hook", date)[0];
  const a = e ? assignArm(e, date, index) : "legacy";
  return a === "top" ? "top" : "legacy";
}

export type ArmRecord = { exp?: string[]; arm?: Record<string, string>; variant: HookLayout };

/**
 * 1本の動画が入る施策・腕・1フレーム目のレイアウト。描画（prep-short）と台帳（publish-all）が同じものを使う。
 * 手動でレイアウトを指定した動画（ffmpeg 経路の legacy を含む）は、hook 施策の対象から外す（描画と記録をずらさない）。
 */
export function armRecordFor(experiments: Experiment[], date: string, index: number, override?: string): ArmRecord {
  const ov = override === "top" || override === "legacy" ? override : undefined;
  const { exp, arm } = armsFor(experiments, ov ? ["news"] : ["news", "hook"], date, index);
  return { ...(exp.length ? { exp, arm } : {}), variant: hookLayoutFor(experiments, date, index, ov) };
}
