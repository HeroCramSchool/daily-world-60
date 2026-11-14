import { test } from "node:test";
import assert from "node:assert/strict";
import { assignBeats, pictureStarts } from "./beat-assign.js";

const HERO = "hero-ir-s1.jpg";
const b = (n: number) => `beat-ir-s1-b${n}.jpg`;
// 3語以上の文を n 個
const S = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} here.`);
// 文ごとのチャンクの数から、チャンクの並びを作る (prep-short.ts の本文の割り方と同じ形)
const chunksOf = (body: Array<string | null>, perSentence: number[]) =>
  body.flatMap((bg, i) => Array.from({ length: perSentence[i] }, (_, k) => ({ bg, sentenceStart: k === 0 })));

test("全部そろう: 冒頭は冒頭の絵、本文は番号どおり", () => {
  assert.deepEqual(assignBeats([b(1), b(2), b(3)], S(3), HERO), { hook: HERO, body: [b(1), b(2), b(3)] });
});

test("b1 だけ欠ける: 1文目は冒頭の絵。冒頭の絵が無ければ番号がいちばん若い絵", () => {
  assert.deepEqual(assignBeats([b(2), b(3)], S(3), HERO), { hook: HERO, body: [HERO, b(2), b(3)] });
  assert.deepEqual(assignBeats([b(2), b(3)], S(3), null), { hook: b(2), body: [b(2), b(2), b(3)] });
});

test("b2 だけ欠ける: 2文目は1文目の絵を続ける", () => {
  assert.deepEqual(assignBeats([b(1), b(3)], S(3), HERO), { hook: HERO, body: [b(1), b(1), b(3)] });
});

test("b1 と b3 が欠けて b2 だけ (2026-11-10 の実例): 2文目用の絵を1文目に出さない", () => {
  assert.deepEqual(assignBeats([b(2)], S(3), HERO), { hook: HERO, body: [HERO, b(2), b(2)] });
  // 冒頭の絵も無ければ、冒頭も本文も残った1枚 (直す前と同じ)
  assert.deepEqual(assignBeats([b(2)], S(3), null), { hook: b(2), body: [b(2), b(2), b(2)] });
});

test("全部欠けて冒頭の絵だけ: 本文は手持ちの写真に落とす", () => {
  assert.deepEqual(assignBeats([], S(3), HERO), { hook: HERO, body: [] });
});

test("冒頭の絵も無い: 何も当てない (呼び出し側が手持ちの写真に落とす)", () => {
  assert.deepEqual(assignBeats([], S(3), null), { hook: null, body: [] });
});

test("絵が文より多い: 余った番号は使わない", () => {
  assert.deepEqual(assignBeats([b(1), b(2), b(3), b(4)], S(3), HERO), { hook: HERO, body: [b(1), b(2), b(3)] });
  assert.deepEqual(assignBeats([b(3), b(4)], S(2), HERO), { hook: HERO, body: [HERO, HERO] });
});

test("文が絵より多い: 最後の絵を続ける", () => {
  assert.deepEqual(assignBeats([b(1), b(2)], S(4), HERO), { hook: HERO, body: [b(1), b(2), b(2), b(2)] });
});

test("文が1つ", () => {
  assert.deepEqual(assignBeats([b(1)], S(1), HERO), { hook: HERO, body: [b(1)] });
  assert.deepEqual(assignBeats([], S(1), HERO), { hook: HERO, body: [] });
  assert.deepEqual(assignBeats([b(2)], S(1), null), { hook: b(2), body: [b(2)] });
  assert.deepEqual(assignBeats([b(1)], S(0), HERO), { hook: HERO, body: [] });
});

test("番号が飛んでいる: 番号で当て、並び順では詰めない。番号は数として比べる", () => {
  assert.deepEqual(assignBeats([b(1), b(4)], S(5), HERO), { hook: HERO, body: [b(1), b(1), b(1), b(4), b(4)] });
  assert.deepEqual(assignBeats([b(2), b(5)], S(3), HERO), { hook: HERO, body: [HERO, b(2), b(2)] });
  // ファイル名の並び順では b10 が b2 より前に来る
  assert.deepEqual(assignBeats([b(10), b(2)], S(3), null), { hook: b(2), body: [b(2), b(2), b(2)] });
  assert.deepEqual(assignBeats([b(10), b(2), "beat-ir-s1-b2.motion.mp4", "bg-ir-s1-1.jpg"], S(10), HERO).body.slice(8), [b(2), b(10)]);
});

test("3語未満のかけらは番号を進めない (fetch-broll.ts の splitBeats と同じ数え方)", () => {
  // 取得側は「Voting is set for Nov.」「Polls show a close race.」「Turnout may pass 60 percent.」に b1〜b3 を振る
  const nov = ["Voting is set for Nov.", "3.", "Polls show a close race.", "Turnout may pass 60 percent."];
  assert.deepEqual(assignBeats([b(1), b(2), b(3)], nov, HERO), { hook: HERO, body: [b(1), b(1), b(2), b(3)] });
  assert.deepEqual(assignBeats([b(1), b(3)], nov, HERO).body, [b(1), b(1), b(1), b(3)]);
  // 頭のかけらは冒頭の絵のまま
  assert.deepEqual(assignBeats([b(1), b(2)], ["Dr.", "Amani says it is over.", "Clinics reopened on Monday."], HERO).body, [HERO, b(1), b(2)]);
});

test("firstOfCue: 最初のチャンクと、前のチャンクと絵が違うチャンクだけ true", () => {
  const chunks = chunksOf([b(1), b(2), b(3)], [2, 3, 2]);
  assert.deepEqual(pictureStarts(chunks, false), [true, false, true, false, false, true, false]);
});

test("firstOfCue: 同じ絵が続く文の頭は false (同じ絵のままの暗転と効果音を出さない)", () => {
  // 2026-11-10 の実例。直す前は文の頭 (0・1・4 番目) が全部 true だった
  const only2 = assignBeats([b(2)], S(3), null).body;
  assert.deepEqual(pictureStarts(chunksOf(only2, [1, 3, 2]), false), [true, false, false, false, false, false]);
  const withHero = assignBeats([b(2)], S(3), HERO).body;
  assert.deepEqual(pictureStarts(chunksOf(withHero, [1, 3, 2]), false), [true, true, false, false, false, false]);
  assert.deepEqual(pictureStarts(chunksOf([HERO, HERO, HERO], [2, 2, 2]), false), [true, false, false, false, false, false]);
});

test("firstOfCue: 手持ちの写真の本も同じ決め方 (文の途中で写真が替われば true、絵が無ければ最初だけ)", () => {
  const photos = [
    { bg: "short/photo-la-01.jpg", sentenceStart: true },
    { bg: "short/photo-la-01.jpg", sentenceStart: false },
    { bg: "short/photo-la-02.jpg", sentenceStart: false },
    { bg: "short/photo-la-02.jpg", sentenceStart: true },
  ];
  assert.deepEqual(pictureStarts(photos, false), [true, false, true, false]);
  assert.deepEqual(pictureStarts(chunksOf([null, null], [2, 1]), false), [true, false, false]);
  assert.deepEqual(pictureStarts([], false), []);
});

test("firstOfCue: 地図の次のチャンクは、文の頭なら絵が同じでも true (地図から絵への切り替えは直す前と同じ)", () => {
  // 1文目が1チャンク = 地図だけで終わる。2文目の頭で地図から絵に替わる
  assert.deepEqual(pictureStarts(chunksOf([HERO, HERO, HERO], [1, 2, 2]), true), [true, true, false, false, false]);
  // 1文目が2チャンク。地図の次は文の途中なので、直す前と同じく false
  assert.deepEqual(pictureStarts(chunksOf([HERO, HERO], [2, 2]), true), [true, false, false, false]);
  // 地図が無い本では、同じ絵の文の頭は false
  assert.deepEqual(pictureStarts(chunksOf([HERO, HERO, HERO], [1, 2, 2]), false), [true, false, false, false, false]);
  // 地図の次で絵が替わるなら、地図の有無によらず true
  assert.deepEqual(pictureStarts(chunksOf([b(1), b(2)], [1, 2]), true), [true, true, false]);
});
