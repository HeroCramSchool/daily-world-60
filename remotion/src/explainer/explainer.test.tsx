import { test } from "node:test";
import assert from "node:assert/strict";
import { hookFontSize, hookHeight } from "./HookCard";
import { decimalsOf, fmtNum } from "./Counter";
import { segmentsOf, hookOpacity } from "./Explainer";
import type { XBeat } from "../lib/explainerTypes";

// Chrome (描画と同じ Inter v20 900) で実際に組んだときの行数。表の見積がこれより少ない行数を出したら見出しが隠れる
const MEASURED: Array<[string, number, number]> = [
  ["12 WARSHIPS SWARM WEST", 116, 3],
  ["12 WARSHIPS SWARM WEST", 104, 2],
  ["100 MW WAVE WARNING", 116, 3],
  ["100 MW WAVE WARNING", 104, 2],
  ["7 MILLION WITHOUT WATER", 96, 3],
  ["7 MILLION WITHOUT WATER", 88, 2],
  ["1,200 TROOPS MOVE TO WARSAW", 88, 3],
  ["1,200 TROOPS MOVE TO WARSAW", 80, 2],
  ["6 WORKERS NEAR TAIWAN", 116, 3],
  ["250 KM MOVE WEST OF MOSCOW", 88, 3],
];
const realHeight = (lines: number, size: number) => lines * size * 1.06 + (lines - 1) * Math.round(size * 0.06);

test("hookHeight: Chrome で実際に組んだ高さを下回らない", () => {
  for (const [t, size, lines] of MEASURED) {
    assert.ok(hookHeight(t, size) >= realHeight(lines, size), `${t} @${size}: ${hookHeight(t, size)} < ${realHeight(lines, size)}`);
  }
});

test("hookFontSize: W・M の多い見出しも hero の箱 (274px) に全行が入る", () => {
  const hooks = [
    "12 WARSHIPS SWARM WEST", "100 MW WAVE WARNING", "7 MILLION WITHOUT WATER", "1,200 TROOPS MOVE TO WARSAW",
    "6 WORKERS NEAR TAIWAN", "250 KM MOVE WEST OF MOSCOW", "18 WARSHIPS SWARM WARSAW NEAR MYANMAR",
    "WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMMM", "40 MW WARSHIPS MASS WEST OF MALMO WAVES",
  ];
  for (const t of hooks) {
    const hero = hookFontSize(t, "hero");
    assert.ok(hookHeight(t, hero) <= 274, `${t}: hero ${hero}px は ${hookHeight(t, hero)}px`);
    const compact = hookFontSize(t, "compact");
    assert.ok(hookHeight(t, compact) <= 132, `${t}: compact ${compact}px は ${hookHeight(t, compact)}px`);
  }
  // 実測で2行に収まるサイズを選ぶ (以前は 116 / 116 / 96 / 88 を選んで最後の語が隠れた)
  assert.equal(hookFontSize("12 WARSHIPS SWARM WEST", "hero"), 104);
  assert.equal(hookFontSize("100 MW WAVE WARNING", "hero"), 104);
  assert.equal(hookFontSize("7 MILLION WITHOUT WATER", "hero"), 88);
  assert.equal(hookFontSize("1,200 TROOPS MOVE TO WARSAW", "hero"), 80);
});

test("hookFontSize: 小文字・表に無い字も大文字として数える", () => {
  assert.equal(hookFontSize("1,250 sample drones in one night", "hero"), hookFontSize("1,250 SAMPLE DRONES IN ONE NIGHT", "hero"));
  assert.equal(hookHeight("ÉTÉ", 100), hookHeight("ETE", 100));
  assert.ok(hookHeight("A→B", 100) >= hookHeight("AWB", 100));
});

test("decimalsOf / fmtNum: 照合した数を丸めない", () => {
  const show = (v: number) => fmtNum(v, decimalsOf(v));
  assert.equal(show(4.375), "4.375");
  assert.equal(show(0.004), "0.004");
  assert.equal(show(1.0845), "1.0845");
  assert.equal(show(151.235), "151.235");
  assert.equal(show(1234567.5), "1,234,567.5");
  assert.equal(show(12500), "12,500");
  // Bars は全項目の最大の桁にそろえる。値は変わらない
  const d = Math.max(...[3, 0.004].map(decimalsOf));
  assert.deepEqual([3, 0.004].map(v => fmtNum(v, d)), ["3.000", "0.004"]);
});

const beat = (id: string, start: number, end: number, words = 2): XBeat => ({
  id, start, end, sourceName: "S",
  words: Array.from({ length: words }, (_, i) => ({ w: `w${i}`, t: start + i * 0.1, d: 0.1 })),
  visual: { kind: "counter", value: 1, label: "x" },
});

test("segmentsOf: 読まれない文 (語が無い・長さ0) を飛ばす", () => {
  const beats = [beat("a", 0.1, 3), beat("b", 3.2, 6), beat("c", 6, 6, 0), beat("d", 6, 6, 1), beat("e", Number.NaN, 7)];
  const segs = segmentsOf(beats, 30, 200);
  assert.deepEqual(segs.map(s => [s.beat.id, s.from, s.to]), [["a", 0, 96], ["b", 96, 200]]);
});

test("segmentsOf + hookOpacity: 文が1つでも投げない", () => {
  const segs = segmentsOf([beat("a", 0.1, 3)], 30, 200);
  assert.equal(segs.length, 1);
  for (const f of [0, 10, 199, 200, 205]) assert.deepEqual(hookOpacity(segs, f, 200), { hero: 1, compact: 0 });
  assert.deepEqual(hookOpacity([], 0, 200), { hero: 1, compact: 0 });
});

test("hookOpacity: 2つ目の文で hero から compact へ、戻りで hero へ", () => {
  const segs = segmentsOf([beat("a", 0.1, 3), beat("b", 3.2, 6)], 30, 200);
  assert.deepEqual(hookOpacity(segs, 50, 200), { hero: 1, compact: 0 });
  assert.deepEqual(hookOpacity(segs, 150, 200), { hero: 0, compact: 1 });
  assert.deepEqual(hookOpacity(segs, 216, 200), { hero: 1, compact: 0 });
});
