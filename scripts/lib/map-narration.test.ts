import { test } from "node:test";
import assert from "node:assert/strict";
import { fillNarration, timeLines, withArticle } from "./map-narration.js";

const counts = { "<1B": 70, "1B-10B": 51, "10B-50B": 22, "50B+": 10 };
const ranked = [{ name: "United States", ccn3: "840" }, { name: "China", ccn3: "156" }, { name: "Tuvalu", ccn3: "798" }];
const allowed = ["MILITARY SPENDING OF EVERY COUNTRY", "Where does yours rank? 👇", "Under $1B", "$1B–$10B", "$10B–$50B", "$50B or more"];

test("件数と国名はデータから入り、その文で読む凡例の鍵と国を返す", () => {
  const out = fillNarration(
    ["How much does every country spend?", "{n:50B+} countries spend 50 billion dollars or more.", "The biggest spender is {top}.", "The smallest is {bottom}."],
    counts, ranked, allowed,
  );
  assert.deepEqual(out.map(l => l.text), [
    "How much does every country spend?", "10 countries spend 50 billion dollars or more.", "The biggest spender is the United States.", "The smallest is Tuvalu.",
  ]);
  assert.deepEqual(out.map(l => l.keys), [[], ["50B+"], [], []]);
  assert.deepEqual(out.map(l => l.highlight), [null, null, "840", "798"]);
});

test("凡例・見出し・CTA に無い数を手で書いたら止める。知らない鍵と差し込みも止める", () => {
  assert.throws(() => fillNarration(["{n:50B+} countries spend 60 billion dollars or more."], counts, ranked, allowed), /60000000000/);
  assert.throws(() => fillNarration(["Half of all countries spend under 1 billion."], counts, ranked, allowed), /0\.5/);
  assert.throws(() => fillNarration(["{n:100B+} countries."], counts, ranked, allowed), /legend key "100B\+"/);
  assert.throws(() => fillNarration(["The biggest is {top}."], counts, [], allowed), /\{top\} needs raw values/);
});

test("読み上げた語を文に割り当てる", () => {
  const lines = fillNarration(["How crowded is it?", "{n:50B+} countries."], counts, ranked, allowed);
  const words = [
    { w: "How", t: 0, d: 0.2 }, { w: "crowded", t: 0.2, d: 0.3 }, { w: "is", t: 0.5, d: 0.1 }, { w: "it?", t: 0.6, d: 0.2 },
    { w: "10", t: 1.0, d: 0.3 }, { w: "countries.", t: 1.3, d: 0.4 },
  ];
  const timed = timeLines(lines, words);
  assert.deepEqual(timed.map(l => [l.start, Math.round(l.end * 10) / 10, l.words.length]), [[0, 0.8, 4], [1.0, 1.7, 2]]);
});

test("the を付けて呼ぶ国名", () => {
  assert.equal(withArticle("United Kingdom"), "the United Kingdom");
  assert.equal(withArticle("Philippines"), "the Philippines");
  assert.equal(withArticle("China"), "China");
});
