import { test } from "node:test";
import assert from "node:assert/strict";
import { narrationSentences, shortTail } from "./short-tail.js";

// 原稿の並びは Script.toStoryNarration: 見出し → 境界の文 → 本文 → 締め → 本ごとの問い → 定型の問い
const HEAD = "Iran war day 254: US disables 11th blockade runner. Here's what's happening.";
const BODY = "The Iran blockade runs on gunfire. CENTCOM counted five on June 1, so the total more than doubled.";
const OUTRO = "And that's the latest from Iran.";
const CTA = "What do you think about this?";
const timed = (narration: string) => narrationSentences(narration).map((text, i) => ({ text, start: i * 2, end: i * 2 + 1.5 }));

test("本ごとの問いがある本: 本文は締めの手前まで。問いは「?」つきで出て、定型の文は時刻だけ残る", () => {
  const t = shortTail(timed(`${HEAD} ${BODY} ${OUTRO} Should the US keep firing on ships that run the Iran blockade? ${CTA}`));
  assert.equal(t.outroIdx, 4);
  assert.equal(t.bodyEnd, 4);
  assert.deepEqual(t.question, {
    text: "Should the US keep firing on ships that run the Iran blockade?",
    start: 10, end: 13.5,
    cta: { text: CTA, start: 12 },
  });
});

test("本ごとの問いが無い本: 定型の文をそのまま出し、小さい1行は付けない", () => {
  const t = shortTail(timed(`${HEAD} ${BODY} ${OUTRO} ${CTA}`));
  assert.equal(t.outroIdx, 4);
  assert.equal(t.bodyEnd, 4);
  assert.deepEqual(t.question, { text: CTA, start: 10, end: 11.5 });
});

test("締めが無い本: 本文は定型の問いの手前まで。締めも問いも無ければ本文が最後まで続く", () => {
  const noOutro = shortTail(timed(`${HEAD} ${BODY} ${CTA}`));
  assert.equal(noOutro.outroIdx, -1);
  assert.equal(noOutro.bodyEnd, 4);
  assert.deepEqual(noOutro.question, { text: CTA, start: 8, end: 9.5 });

  const bodyOnly = shortTail(timed(`${HEAD} ${BODY}`));
  assert.deepEqual(bodyOnly, { bodyEnd: 4, outroIdx: -1, question: null });

  const outroOnly = shortTail(timed(`${HEAD} ${BODY} ${OUTRO}`));
  assert.deepEqual(outroOnly, { bodyEnd: 4, outroIdx: 4, question: null });
});

test("本文に subscribe や that's the latest に似た文があっても、締めは最後の一致", () => {
  const body = "Millions subscribe to the state news app. Officials say that's the latest sign of a wider war. Reporters asked, what do you think about this? The minister did not answer.";
  const t = shortTail(timed(`${HEAD} ${body} ${OUTRO} Will the app be blocked abroad? ${CTA}`));
  assert.equal(t.outroIdx, 6);
  assert.equal(t.bodyEnd, 6);
  assert.deepEqual(t.question, { text: "Will the app be blocked abroad?", start: 14, end: 17.5, cta: { text: CTA, start: 16 } });
});

test("問いが2文でも1枚にまとめ、文ごとに分けない", () => {
  const t = shortTail(timed(`${HEAD} ${BODY} ${OUTRO} Is this the end of the ceasefire? Or can talks in Doha still stop a wider war? ${CTA}`));
  assert.equal(t.bodyEnd, 4);
  assert.deepEqual(t.question, {
    text: "Is this the end of the ceasefire? Or can talks in Doha still stop a wider war?",
    start: 10, end: 15.5,
    cta: { text: CTA, start: 14 },
  });
});

test("略語 (U.S.) で問いが割れても、つないで1つの問いにする", () => {
  const q = "Should the U.S. keep firing on ships that run the Iran blockade?";
  assert.deepEqual(narrationSentences(q), ["Should the U.S.", "keep firing on ships that run the Iran blockade?"]);
  const t = shortTail(timed(`${HEAD} ${BODY} ${OUTRO} ${q} ${CTA}`));
  assert.equal(t.bodyEnd, 4);
  assert.deepEqual(t.question, { text: q, start: 10, end: 15.5, cta: { text: CTA, start: 14 } });
});

test("文の切り方は prep-short の sentenceBounds と同じ (英数字の無いかけらは数えない)", () => {
  assert.deepEqual(narrationSentences("  A b.  ...  C d?\nE f! "), ["A b.", "C d?", "E f!"]);
});
