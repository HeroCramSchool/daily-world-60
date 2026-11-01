import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { DeskResult, DeskStory, NewsDeskPort } from "../application/ports/NewsDeskPort.js";
import { STATUS_FILE, storyboardFile, styleFor, type ExplainerStatusFile } from "../domain/storyboard/ExplainerArm.js";
import type { Experiment } from "../domain/experiment/Experiment.js";
import { loadRegistryOrEmpty } from "../infrastructure/pdca/RegistryFile.js";
import { CostMeter, type CallRecord } from "../infrastructure/claude/CostMeter.js";
import { NewsDesk } from "../infrastructure/claude/NewsDesk.js";

/**
 * Step A2: Routine の台本のうち解説形式に割り付けた本を、Claude API で解説形式の台本にする。
 *
 * 入力:  $OUT_DIR/script-en.json（既定 output/<date>/）
 * 出力:  $OUT_DIR/storyboard-<index>-<code>.json（照合と反証を通った本だけ）・explainer-status.json・claude-usage.json
 *
 * 割り付けは styleFor（EXPLAINER=on|off の手動指定 > 施策の腕 > 採用済み > 今の形式）。
 * ANTHROPIC_API_KEY が無ければ disabled。費用の上限は EXPLAINER_DAILY_CAP_USD（既定 $4、その回の全部の本の合計）。
 * 解説形式の本ごとに EXPLAINER_STORY_CAP_USD（既定 $1.2）を投稿順に最初に押さえ、押さえられない本は呼ばずに cap にする
 * （どの本が cap になるかを中身でなく投稿順で決めるため）。本の中の呼び出しはその予算から押さえる。
 * どの本が失敗しても止めない（その本は今の形式で描く）。0 以外で終わるのはコードの誤りのときだけ。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const USAGE_FILE = "claude-usage.json";
// 3本 × 本ごとの予算に余裕を足した額
const DEFAULT_CAP_USD = 4;
// 調べる 0.5 + 書く 0.15×2 + 反証 0.15×2（RESERVE）が収まる額。初回の claude-usage.json の実額で決め直す
export const DEFAULT_STORY_CAP_USD = 1.2;
// ジョブ全体（publish.yml の timeout-minutes）を食い尽くさないための締め切り。切れた本は今の形式で描く
const DEFAULT_DEADLINE_SEC = 720;

type ScriptStory = {
  index: number;
  country: { code: string; name?: string };
  headline?: string;
  summary?: string;
  sourceName?: string;
  sourceUrl?: string;
  mapMarkers?: Array<{ label?: string } | null>;
};

export type RunOptions = {
  date: string;
  dir: string;
  experiments: Experiment[];
  override?: string;
  apiKey?: string;
  capUsd: number;
  /** 解説形式の本1本の予算。既定 DEFAULT_STORY_CAP_USD。 */
  storyCapUsd?: number;
  makeDesk: (meter: CostMeter, apiKey: string, signal?: AbortSignal) => NewsDeskPort;
  /** 全部の本を合わせた締め切り（ミリ秒）。 */
  deadlineMs?: number;
  log?: (line: string) => void;
};

export type RunResult = { status: ExplainerStatusFile; totalUsd: number; calls: CallRecord[]; crashed: string[] };

export function capFromEnv(v: string | undefined, def = DEFAULT_CAP_USD): number {
  const n = v?.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** 施策台帳の全部（styleFor は採用済み adopted も見るので、動いている施策だけに絞らない）。 */
export function registryExperiments(file?: string): Experiment[] {
  return loadRegistryOrEmpty(file).experiments;
}

function secFromEnv(v: string | undefined, def: number): number {
  const n = v?.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

async function readStories(dir: string, log: (s: string) => void): Promise<ScriptStory[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "script-en.json"), "utf-8");
  } catch {
    log(`[explainers] ${path.join(dir, "script-en.json")} が無い — 解説形式は作らない`);
    return [];
  }
  try {
    const stories = (JSON.parse(raw) as { stories?: unknown }).stories;
    return (Array.isArray(stories) ? stories : []).filter((s): s is ScriptStory =>
      !!s && typeof s.index === "number" && typeof s.country?.code === "string" && !!s.country.code.trim());
  } catch (e) {
    log(`[explainers] script-en.json を読めない (${e instanceof Error ? e.message : e}) — 解説形式は作らない`);
    return [];
  }
}

function toDeskStory(s: ScriptStory, date: string): DeskStory {
  const places = (s.mapMarkers ?? []).map(m => m?.label?.trim()).filter((p): p is string => !!p);
  return {
    date,
    index: s.index,
    countryCode: s.country.code,
    ...(s.country.name ? { countryName: s.country.name } : {}),
    headline: s.headline ?? "",
    summary: s.summary ?? "",
    sourceName: s.sourceName ?? "",
    ...(s.sourceUrl ? { sourceUrl: s.sourceUrl } : {}),
    ...(places.length ? { places } : {}),
  };
}

export async function writeExplainers(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (s => console.log(s));
  const stories = await readStories(opts.dir, log);
  const apiKey = opts.apiKey?.trim();
  const meter = new CostMeter(opts.capUsd);
  const decisions = stories.map(s => styleFor(opts.experiments, opts.date, s.index, opts.override));
  const wanted = decisions.filter(d => d.style === "explainer").length;
  if (wanted && !apiKey) log(`::warning::ANTHROPIC_API_KEY が無いので解説形式を作らない（割り付けた ${wanted} 本は今の形式で描く）`);
  const signal = opts.deadlineMs ? AbortSignal.timeout(opts.deadlineMs) : undefined;
  const desk = wanted && apiKey ? opts.makeDesk(meter, apiKey, signal) : null;
  const storyCap = opts.storyCapUsd ?? DEFAULT_STORY_CAP_USD;
  const budgeted = new Set<number>();
  if (desk) {
    const order = [...stories.keys()].filter(i => decisions[i].style === "explainer").sort((a, b) => stories[a].index - stories[b].index);
    for (const i of order) if (meter.openStory(stories[i].index, storyCap)) budgeted.add(i);
  }

  const settled = await Promise.allSettled(stories.map(async (s, i): Promise<DeskResult> => {
    if (decisions[i].style !== "explainer") return { status: "not_assigned", docs: [], errors: [], costUsd: 0 };
    if (!desk) return { status: "disabled", docs: [], errors: [], costUsd: 0 };
    if (!budgeted.has(i)) return { status: "cap", docs: [], errors: [`1回の実行の上限 $${opts.capUsd} に、この本の予算 $${storyCap} が収まらない（投稿順に押さえる）`], costUsd: 0 };
    return desk.write(toDeskStory(s, opts.date));
  }));

  const status: ExplainerStatusFile = {};
  const crashed: string[] = [];
  for (const [i, s] of stories.entries()) {
    const code = s.country.code.toLowerCase();
    const st = settled[i];
    // コードの誤りは呼ぶ前でも Routine のデータ（その本の中身）で起きうるので、呼び出しの数を見ずに腕に数える
    const r: DeskResult = st.status === "fulfilled"
      ? st.value
      : {
        status: "incomplete",
        docs: [],
        errors: [`コードの誤りで止まった: ${st.reason instanceof Error ? st.reason.stack ?? st.reason.message : String(st.reason)}`],
        costUsd: meter.storyCost(s.index),
      };
    if (st.status === "rejected") crashed.push(`${s.index} ${code}`);
    const file = path.join(opts.dir, storyboardFile(s.index, code));
    // 前の回の台本が残っていると prep-short が今回落ちた本まで解説形式で描くので消す
    if (r.status === "ok" && r.storyboard) await fs.writeFile(file, JSON.stringify(r.storyboard, null, 2));
    else await fs.rm(file, { force: true });
    status[String(s.index)] = {
      status: r.status,
      code,
      ...(r.errors.length ? { errors: r.errors } : {}),
      ...(r.costUsd ? { costUsd: round6(r.costUsd) } : {}),
    };
    const why = r.errors[0] ? ` — ${r.errors[0].split("\n")[0].slice(0, 160)}` : "";
    // api_error は比較から外れるので、設定の誤り (400 など) に気づけるよう Actions の誤りの印を付ける
    log(`${r.status === "api_error" ? "::error::" : ""}[explainers] ${s.index} ${code}: ${r.status} ($${r.costUsd.toFixed(3)}, docs ${r.docs.length})${why}`);
  }

  const calls = meter.calls();
  const totalUsd = meter.spent;
  await fs.mkdir(opts.dir, { recursive: true });
  await fs.writeFile(path.join(opts.dir, STATUS_FILE), JSON.stringify(status, null, 2));
  await fs.writeFile(path.join(opts.dir, USAGE_FILE), JSON.stringify({
    date: opts.date,
    capUsd: opts.capUsd,
    storyCapUsd: storyCap,
    totalUsd: round6(totalUsd),
    calls: calls.map(c => ({ ...c, costUsd: round6(c.costUsd) })),
  }, null, 2));
  log(`[explainers] total $${totalUsd.toFixed(3)} / cap $${opts.capUsd} (${calls.length} calls)`);
  return { status, totalUsd, calls, crashed };
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join(ROOT, "output", date);
  const res = await writeExplainers({
    date,
    dir,
    experiments: registryExperiments(),
    override: process.env.EXPLAINER,
    apiKey: process.env.ANTHROPIC_API_KEY,
    capUsd: capFromEnv(process.env.EXPLAINER_DAILY_CAP_USD),
    storyCapUsd: capFromEnv(process.env.EXPLAINER_STORY_CAP_USD, DEFAULT_STORY_CAP_USD),
    makeDesk: (meter, apiKey, signal) => new NewsDesk({ client: new Anthropic({ apiKey }), meter, signal }),
    deadlineMs: secFromEnv(process.env.EXPLAINER_DEADLINE_SEC, DEFAULT_DEADLINE_SEC) * 1000,
  });
  if (res.crashed.length) {
    console.error(`[explainers] コードの誤りで止まった本: ${res.crashed.join(", ")}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
