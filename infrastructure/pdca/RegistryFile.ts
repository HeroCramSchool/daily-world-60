import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistry, type Registry } from "../../domain/experiment/Experiment.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const REGISTRY_PATH = path.join(REPO_ROOT, "experiments", "registry.json");
export const LEARNINGS_PATH = path.join(REPO_ROOT, "experiments", "learnings.md");

export function loadRegistry(file = REGISTRY_PATH): Registry {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Registry;
}

/**
 * 描画・投稿の途中で台帳が読めなくても止めない（施策なし＝既定の作り方で続ける）。
 * 検査に通らない施策は外す（投稿の途中で例外を出して台帳の記録を失わないため）。
 */
export function loadRegistryOrEmpty(file = REGISTRY_PATH): Registry {
  try {
    const reg = loadRegistry(file);
    const { errors } = validateRegistry(reg);
    const bad = new Set(reg.experiments.map(e => e.id).filter(id => errors.some(m => m.startsWith(`${id}:`) || m.startsWith(`${id} と`) || m.includes(` と ${id}:`))));
    if (bad.size) console.warn(`[pdca] 検査に通らない施策を外す: ${[...bad].join(", ")}`);
    return { ...reg, experiments: reg.experiments.filter(e => !bad.has(e.id)) };
  } catch (e) {
    console.warn(`[pdca] registry を読めない (${e instanceof Error ? e.message : e}) — 施策なしで続ける`);
    return { version: 1, sigma: 1.41, defaultDecide: { adoptIf: "ratio>=1.3 && lo>=0.8", rejectIf: "ratio<1.0" }, experiments: [] };
  }
}
