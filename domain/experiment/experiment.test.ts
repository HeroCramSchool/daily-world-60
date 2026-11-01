import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistry, conflicts, learningsMarkdown, type Experiment, type Registry } from "./Experiment.js";
import { parseRule, holds } from "./Rule.js";
import { minDetectableRatio, minDetectableRatio2, nPerArmFor } from "./Power.js";
import { assignArm, armsFor, armRecordFor, hookLayoutFor, hash32 } from "./Assignment.js";
import { evaluate, geoMeanRatio, stratifiedRatio, clusterBootstrap, dailyShares, type Row } from "./Verdict.js";
import * as fs from "node:fs";

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

test("手動のレイアウト指定は hook 施策の対象から外す", () => {
  const hook = base({ id: "hook-x", lane: "hook", arms: ["top", "legacy"], control: "legacy", unit: "day" });
  const r = armRecordFor([base(), hook], "2026-11-05", 1, "legacy");
  assert.equal(r.variant, "legacy");
  assert.ok(!(r.exp ?? []).includes("hook-x"));
  assert.ok((r.exp ?? []).includes("x-2026-11"));
});

test("比で判定する施策は腕2つ・群の大きさが違う検出力", () => {
  assert.ok(validateRegistry(reg([base({ arms: ["a", "b", "c"] })])).errors.some(m => m.includes("腕を2つ")));
  assert.ok(minDetectableRatio2(10, 60, 1.41) > minDetectableRatio(35, 1.41));
});

test("判定日でも7日たっていない動画が残れば待つ・中央値の比で判定できる", () => {
  const rs: Row[] = [];
  for (let d = 1; d <= 10; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    rs.push({ videoId: `t${d}`, date: day, arm: "b", at7d: 300, matured: true }, { videoId: `c${d}`, date: day, arm: "a", at7d: 100, matured: true });
  }
  const e = base({ decide: { minN: 5, adoptIf: "medRatio>=2", rejectIf: "medRatio<=1" } });
  assert.equal(evaluate(e, rs, "2026-12-07", reg([]).defaultDecide).state, "adopt");
  const waiting = [...rs, { videoId: "late", date: "2026-11-30", arm: "a", matured: false }];
  const v = evaluate(e, waiting, "2026-12-07", reg([]).defaultDecide);
  assert.equal(v.state, "collecting");
  assert.match(v.reason, /7日たっていない/);
});

const l1 = (x: number) => Math.log1p(x);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

test("動画ごとの割り付け: 比は同じ日どうしの対数の差の平均", () => {
  const rs = rows([
    ["2026-11-01", "b", 300], ["2026-11-01", "a", 40], ["2026-11-01", "b", 90],
    ["2026-11-02", "a", 900], ["2026-11-02", "b", 2000], ["2026-11-02", "a", 1500],
    ["2026-11-03", "b", 15], ["2026-11-03", "a", 9], ["2026-11-03", "a", 30],
  ]);
  const want = Math.exp(avg([
    avg([l1(300), l1(90)]) - l1(40),
    l1(2000) - avg([l1(900), l1(1500)]),
    l1(15) - avg([l1(9), l1(30)]),
  ]));
  assert.ok(Math.abs(stratifiedRatio(rs, "b", "a")! - want) < 1e-9);
  const v = evaluate(base(), rs, "2026-12-07", reg([]).defaultDecide);
  assert.ok(Math.abs(v.ratio! - want) < 1e-9);
  assert.ok(Math.abs(v.ratio! - geoMeanRatio(rs, "b", "a")!) > 0.01, "日でまとめない比と同じでは確かめにならない");
  // 日ごとの割り付け（unit=day）は今までどおり全期間をまとめた比
  assert.equal(evaluate(base({ unit: "day" }), rs, "2026-12-07", reg([]).defaultDecide).ratio, geoMeanRatio(rs, "b", "a"));
});

test("片方の腕しか無い日は、比にも区間にも入らない", () => {
  const paired = rows([
    ["2026-11-01", "b", 120], ["2026-11-01", "a", 60],
    ["2026-11-02", "b", 30], ["2026-11-02", "a", 20], ["2026-11-02", "a", 10],
    ["2026-11-03", "b", 500], ["2026-11-03", "a", 200],
  ]);
  const extra = [...paired, ...rows([["2026-11-04", "b", 99999], ["2026-11-04", "b", 88888], ["2026-11-05", "a", 1]])];
  assert.equal(stratifiedRatio(extra, "b", "a"), stratifiedRatio(paired, "b", "a"));
  const e = base();
  const vp = evaluate(e, paired, "2026-12-07", reg([]).defaultDecide);
  const ve = evaluate(e, extra, "2026-12-07", reg([]).defaultDecide);
  assert.deepEqual([ve.ratio, ve.lo, ve.hi], [vp.ratio, vp.lo, vp.hi]);
  assert.equal(stratifiedRatio(rows([["2026-11-01", "b", 5], ["2026-11-02", "a", 5]]), "b", "a"), undefined);
});

test("再生の多い日に新形式の本だけ外れても、比は動かない", () => {
  // どの日も新形式は今の形式のちょうど2倍（log1p で）。日の再生の大きさは日ごとに大きく違う
  const mood = [10, 400, 25, 3000, 60, 150, 8, 900];
  const days = mood.map((_, i) => `2026-11-${String(i + 5).padStart(2, "0")}`);
  const all: Row[] = [];
  days.forEach((day, i) => {
    const m = mood[i];
    const arms = i % 2 ? ["b", "a", "b"] : ["a", "b", "a"];
    arms.forEach((arm, k) => all.push({ videoId: `${day}-${k}`, date: day, arm, at7d: arm === "b" ? 2 * m - 1 : m - 1, matured: true }));
  });
  // 11/08（再生の最も多い日）の新形式だけが、キー未設定などで比較から外れた
  const cut = all.filter(r => !(r.date === "2026-11-08" && r.arm === "b"));
  const e = base({ window: { start: "2026-11-05", end: "2026-11-12", decideOn: "2026-11-20" } });
  const before = evaluate(e, all, "2026-11-20", reg([]).defaultDecide).ratio!;
  const after = evaluate(e, cut, "2026-11-20", reg([]).defaultDecide).ratio!;
  assert.ok(Math.abs(before - 2) < 1e-9 && Math.abs(after - 2) < 1e-9, `before=${before} after=${after}`);
  // まとめた比なら大きく動く（直す前の計算）
  assert.ok(Math.abs(geoMeanRatio(all, "b", "a")! - geoMeanRatio(cut, "b", "a")!) > 0.3);
  const ci = evaluate(e, cut, "2026-11-20", reg([]).defaultDecide);
  assert.ok(Math.abs(ci.lo! - 2) < 1e-9 && Math.abs(ci.hi! - 2) < 1e-9, `lo=${ci.lo} hi=${ci.hi}`);
});

test("止める条件は投稿48時間後の再生でも書ける（nT48・medRatio48）", () => {
  assert.deepEqual(parseRule("nT48>=10 && medRatio48<0.5")[0].map(c => c.v), ["nT48", "medRatio48"]);
  const e = base({ decide: { minN: 5, adoptIf: "ratio>=1.0", rejectIf: "ratio<0.7", stopIf: "nT48>=10 && medRatio48<0.5" } });
  const mk = (nT: number): Row[] => {
    const rs: Row[] = [];
    for (let i = 0; i < 12; i++) {
      const day = `2026-11-${String(i + 1).padStart(2, "0")}`;
      // 7日はまだたっていない。48時間後の再生だけがある
      if (i < nT) rs.push({ videoId: `t${i}`, date: day, arm: "b", at48h: 10 + i, matured: false });
      rs.push({ videoId: `c${i}`, date: day, arm: "a", at48h: 100 + i, matured: false });
    }
    return rs;
  };
  const v = evaluate(e, mk(10), "2026-11-13", reg([]).defaultDecide);
  assert.equal(v.state, "stop");
  assert.equal(v.arms48?.find(a => a.arm === "b")?.n, 10);
  assert.equal(evaluate(e, mk(9), "2026-11-13", reg([]).defaultDecide).state, "collecting");
  // 48時間後でも新形式が半分以上なら止めない
  const ok = mk(10).map(r => r.arm === "b" ? { ...r, at48h: 80 } : r);
  assert.equal(evaluate(e, ok, "2026-11-13", reg([]).defaultDecide).state, "collecting");
  // 7日後の数字（nT・medRatio）は48時間後の数字では埋まらない
  assert.equal(evaluate({ ...e, decide: { ...e.decide!, stopIf: "nT>=1" } }, mk(10), "2026-11-13", reg([]).defaultDecide).state, "collecting");
});

test("48時間後の数字は止める条件だけに使う（採用・不採用は7日後で決める）", () => {
  const bad = validateRegistry(reg([base({ decide: { minN: 5, adoptIf: "ratio>=1.3 && medRatio48>=1", rejectIf: "ratio<1.0" } })]));
  assert.ok(bad.errors.some(m => m.includes("adoptIf") && m.includes("48")), bad.errors.join("\n"));
  const badReject = validateRegistry(reg([base({ decide: { minN: 5, adoptIf: "ratio>=1.3", rejectIf: "nT48>=3" } })]));
  assert.ok(badReject.errors.some(m => m.includes("rejectIf") && m.includes("48")), badReject.errors.join("\n"));
  assert.deepEqual(validateRegistry(reg([base({ decide: { minN: 5, adoptIf: "ratio>=1.3", stopIf: "nT48>=10 && medRatio48<0.5" } })])).errors, []);
});

test("news-explainer-2026-11: 止める条件は期間の中（11/15 の判定）で当たりうる", () => {
  const real = JSON.parse(fs.readFileSync(new URL("../../experiments/registry.json", import.meta.url), "utf-8")) as Registry;
  assert.deepEqual(validateRegistry(real).errors, []);
  const e = real.experiments.find(x => x.id === "news-explainer-2026-11")!;
  const H = 3600e3;
  const vids: Array<{ id: string; date: string; arm: string; pub: number }> = [];
  for (let t = Date.parse(`${e.window!.start}T00:00:00Z`); t <= Date.parse(`${e.window!.end}T00:00:00Z`); t += 24 * H) {
    const date = new Date(t).toISOString().slice(0, 10);
    // publish.yml は 20:00Z に回り、2本目以降は30分ずつ遅れて出る
    for (const i of [1, 2, 3]) vids.push({ id: `${date}-${i}`, date, arm: assignArm(e, date, i), pub: Date.parse(`${date}T20:00:00Z`) + (i - 1) * 30 * 60e3 });
  }
  // 最悪の場合: 新形式は毎回10回、今の形式は100回。判定は毎日 17:30Z（stats.yml）
  let first: string | undefined;
  for (let t = Date.parse(`${e.window!.start}T17:30:00Z`); t <= Date.parse(`${e.window!.decideOn}T17:30:00Z`) && !first; t += 24 * H) {
    const rs: Row[] = vids.filter(v => v.pub < t).map(v => {
      const age = (t - v.pub) / H;
      const views = v.arm === "explainer" ? 10 : 100;
      return { videoId: v.id, date: v.date, arm: v.arm, at7d: age >= 168 ? views : undefined, at48h: age >= 48 ? views : undefined, matured: age >= 168 };
    });
    if (evaluate(e, rs, new Date(t).toISOString().slice(0, 10), real.defaultDecide).state === "stop") first = new Date(t).toISOString().slice(0, 10);
  }
  assert.ok(first && first <= "2026-11-15", `最初に止まる判定日: ${first}`);
  assert.ok(first! < e.window!.end);
});
