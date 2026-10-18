import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistry, conflicts, learningsMarkdown, type Experiment, type Registry } from "./Experiment.js";
import { parseRule, holds } from "./Rule.js";
import { minDetectableRatio, nPerArmFor } from "./Power.js";
import { assignArm, armsFor, hookLayoutFor, hash32 } from "./Assignment.js";
import { evaluate, geoMeanRatio, clusterBootstrap, dailyShares, type Row } from "./Verdict.js";

const plan5 = { konkyo: "a", kasetsu: "b", kitai: "c", hakarikata: "d", yameru: "e" };
const base = (o: Partial<Experiment> = {}): Experiment => ({
  id: "x-2026-11", title: "t", status: "running", design: "randomized", lane: "news", unit: "video",
  arms: ["b", "a"], control: "a", armSource: { by: "hash" }, plan5,
  window: { start: "2026-11-01", end: "2026-11-30", decideOn: "2026-12-07" },
  decide: { minN: 5, adoptIf: "ratio>=1.3 && lo>=0.8", rejectIf: "ratio<1.0" }, ...o,
});
const reg = (es: Experiment[]): Registry => ({ version: 1, sigma: 1.41, defaultDecide: { adoptIf: "ratio>=1.3 && lo>=0.8", rejectIf: "ratio<1.0" }, experiments: es });

test("判定の式: AND/OR と欠けた変数", () => {
  assert.equal(holds("ratio>=1.3 && lo>=0.8", { ratio: 1.4, lo: 0.9 }), true);
  assert.equal(holds("ratio>=1.3 && lo>=0.8", { ratio: 1.4, lo: 0.7 }), false);
  assert.equal(holds("ratio<1.0 || n<3", { ratio: 1.2, n: 2 }), true);
  assert.equal(holds("ratio>=1.3", {}), false);
  assert.throws(() => parseRule("ratio >= abc"));
  assert.throws(() => parseRule("foo>=1"));
});

test("見分けられる最小の差は過去の計算と一致する", () => {
  assert.equal(minDetectableRatio(18, 1.41).toFixed(2), "3.73");
  assert.equal(minDetectableRatio(60, 1.41).toFixed(2), "2.06");
  assert.equal(nPerArmFor(2, 1.41), 65);
  assert.equal(nPerArmFor(1.5, 1.41), 190);
});

test("割り付けは何度呼んでも同じで、期間外は control", () => {
  const e = base();
  const a1 = assignArm(e, "2026-11-05", 2);
  assert.equal(assignArm(e, "2026-11-05", 2), a1);
  assert.equal(assignArm(e, "2026-10-31", 2), "a");
  assert.equal(assignArm({ ...e, status: "draft" }, "2026-11-05", 2), "a");
  let b = 0;
  for (let d = 1; d <= 30; d++) for (let i = 1; i <= 3; i++) if (assignArm(e, `2026-11-${String(d).padStart(2, "0")}`, i) === "b") b++;
  assert.ok(b > 25 && b < 65, `腕の偏りが大きすぎる: b=${b}/90`);
  assert.notEqual(hash32("a"), hash32("b"));
});

test("台帳に残す施策と腕・冒頭レイアウト", () => {
  const hook = base({ id: "hook-x", lane: "hook", arms: ["top", "legacy"], control: "legacy", unit: "day" });
  const r = armsFor([base(), hook], ["news", "hook"], "2026-11-05", 1);
  assert.deepEqual(r.exp, ["x-2026-11", "hook-x"]);
  assert.equal(hookLayoutFor([hook], "2026-11-05", 1), r.arm["hook-x"] === "top" ? "top" : "legacy");
  assert.equal(hookLayoutFor([hook], "2026-11-05", 1, "top"), "top");
  assert.equal(hookLayoutFor([], "2026-11-05", 1), "legacy");
});

test("台帳の検査: 5点の欠け・決定の欠け・枠の重なり", () => {
  assert.deepEqual(validateRegistry(reg([base()])).errors, []);
  const noPlan = validateRegistry(reg([base({ plan5: { ...plan5, yameru: "" } })]));
  assert.ok(noPlan.errors.some(m => m.includes("やめる条件")));
  const closed = validateRegistry(reg([base({ status: "rejected" })]));
  assert.ok(closed.errors.some(m => m.includes("decision")));
  const a = base({ id: "a-1" }), b = base({ id: "b-1", window: { start: "2026-11-20", end: "2026-12-10", decideOn: "2026-12-17" } });
  assert.equal(conflicts(a, b), true);
  assert.ok(validateRegistry(reg([a, b])).errors.some(m => m.includes("同じ枠")));
  assert.equal(conflicts(a, base({ id: "c-1", lane: "map" })), false);
  assert.match(learningsMarkdown(reg([])), /まだ無い/);
});

const rows = (spec: Array<[string, string, number]>): Row[] => spec.map(([date, arm, v], i) => ({ videoId: `v${i}`, date, arm, at7d: v }));

test("判定: 比と日ごとの区間・判定日・本数不足", () => {
  const rs: Row[] = [];
  for (let d = 1; d <= 20; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    const mood = d % 3 === 0 ? 4 : 1;   // 日ごとのニュースの強さ
    rs.push(...rows([[day, "b", 200 * mood], [day, "a", 50 * mood], [day, "a", 60 * mood]]));
  }
  const ratio = geoMeanRatio(rs, "b", "a")!;
  assert.ok(ratio > 3 && ratio < 4.5, `ratio=${ratio}`);
  const ci = clusterBootstrap(rs, "b", "a")!;
  assert.ok(ci[0] < ratio && ratio < ci[1]);
  const e = base();
  assert.equal(evaluate(e, rs, "2026-11-20", reg([]).defaultDecide).state, "collecting");
  assert.equal(evaluate(e, rs, "2026-12-07", reg([]).defaultDecide).state, "adopt");
  assert.equal(evaluate({ ...e, decide: { minN: 50 } }, rs, "2026-12-07", reg([]).defaultDecide).state, "inconclusive");
  assert.equal(evaluate({ ...e, decide: { minN: 1, stopIf: "nT>=5 && medT<1000" } }, rs, "2026-11-10", reg([]).defaultDecide).state, "stop");
});

test("観察（順位ごと）は判定日にオーナー判断、日の合計の割合を出す", () => {
  const rs = rows([["2026-10-01", "1", 60], ["2026-10-01", "2", 30], ["2026-10-01", "3", 10], ["2026-10-02", "1", 10], ["2026-10-02", "2", 10]]);
  const e = base({ design: "observational", arms: ["1", "2", "3"], control: "1", decide: { minN: 1, manual: true } });
  const v = evaluate(e, rs, "2026-12-07", reg([]).defaultDecide);
  assert.equal(v.state, "manual");
  assert.equal(dailyShares(rs, ["1", "2", "3"])!["1"].toFixed(2), "0.60");
});
