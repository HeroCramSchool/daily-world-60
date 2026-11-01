import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText, numbersIn, canonicalUrl, checkFacts, alignBeats, LIMITS,
  type Storyboard, type FetchedDoc, type CheckOptions, type StoryLine, type Word,
} from "./Storyboard.js";
import { styleFor, finalizeArmRecord, explainerExperiment, storyboardFile, type StyleDecision } from "./ExplainerArm.js";
import { armRecordFor, assignArm } from "../experiment/Assignment.js";
import type { Experiment } from "../experiment/Experiment.js";

test("normalizeText: 引用符・ダッシュ・空白・全角をそろえる", () => {
  assert.equal(normalizeText("  “Hello,” she said — ‘it’s 6′2″’  "), `"hello," she said - 'it's 6'2"'`);
  assert.equal(normalizeText("a\u00a0b\u2009c\u200bd\ufeffe\n\tf"), "a b c d e f");
  assert.equal(normalizeText("10–20 −5 ‒3 ―x"), "10-20 -5 -3 -x");
  assert.equal(normalizeText("ＡＢＣ１２３\u3000ｘ"), "abc123 x");
  assert.equal(normalizeText("wait…"), "wait...");
  assert.equal(normalizeText("re\u00adport"), "report");
  assert.equal(normalizeText(""), "");
});

test("numbersIn: 数字の書き方の揺れをそろえる", () => {
  assert.deepEqual(numbersIn("1,009 people"), ["1009"]);
  assert.deepEqual(numbersIn("1,200,000 and 1,2"), ["1200000", "1", "2"]);
  assert.deepEqual(numbersIn("£3.50 or 3.0 or 007"), ["3.5", "3", "7"]);
  assert.deepEqual(numbersIn("40% of $94bn"), ["40", "94"]);
  assert.deepEqual(numbersIn("the 1st and 22nd"), ["1", "22"]);
  assert.deepEqual(numbersIn("50-60 dead"), ["50", "60"]);
  assert.deepEqual(numbersIn("50–60 dead"), ["50", "60"]);
  assert.deepEqual(numbersIn("1.2 million in 2026."), ["1.2", "2026"]);
  assert.deepEqual(numbersIn("a .5 rise"), ["0.5"]);
  assert.deepEqual(numbersIn("3 then 3 again"), ["3"]);
  assert.deepEqual(numbersIn("no digits here"), []);
  assert.deepEqual(numbersIn("１２ people"), ["12"]);
});

test("numbersIn: 語の数", () => {
  assert.deepEqual(numbersIn("Three people and twenty soldiers"), ["3", "20"]);
  assert.deepEqual(numbersIn("zero, eleven, nineteen, ninety"), ["0", "11", "19", "90"]);
  assert.deepEqual(numbersIn("twenty-five or forty two"), ["25", "42"]);
  assert.deepEqual(numbersIn("twenty, five"), ["20", "5"]);
  assert.deepEqual(numbersIn("the twenty-first century"), ["21"]);
  assert.deepEqual(numbersIn("Rs 5 crore"), ["5"]);
  assert.deepEqual(numbersIn("a dozen eggs"), ["12"]);
  assert.deepEqual(numbersIn("someone, anyone, everyone"), []);
  // 桁の語は数に含めない（桁は checkFacts が別に照合する）。"five hundred" が "500" に一致することは無い。
  assert.deepEqual(numbersIn("five hundred"), ["5"]);
  assert.ok(!numbersIn("five hundred").includes("500"));
  assert.deepEqual(numbersIn("a million people"), ["1"]);
  // 大まかな量の語はそのまま返し、引用文にも同じ語が要るようにする。
  assert.deepEqual(numbersIn("Tens of thousands fled"), ["tens", "thousands"]);
  assert.deepEqual(numbersIn("half a million"), ["half"]);
});

test("canonicalUrl: スキーム・www・クエリ・#・末尾の / を落とす", () => {
  assert.equal(canonicalUrl("https://www.APNews.com/article/x-1?utm_source=a#top"), "apnews.com/article/x-1");
  assert.equal(canonicalUrl("http://apnews.com/article/x-1/"), "apnews.com/article/x-1");
  assert.equal(canonicalUrl("apnews.com/article/x-1"), "apnews.com/article/x-1");
  assert.equal(canonicalUrl("https://www.reuters.com/"), "reuters.com");
  assert.notEqual(canonicalUrl("https://apnews.com/article/x-1"), canonicalUrl("https://apnews.com/article/x-2"));
});

const AP = "https://apnews.com/article/turkey-earthquake-sindirgi-abc123";
const RT = "https://www.reuters.com/world/middle-east/turkey-quake-2026-11-01/";
const DOCS: FetchedDoc[] = [
  {
    url: AP, via: "web_fetch", title: "Quake hits western Turkey",
    text: "ISTANBUL (AP) — A magnitude 6.1 earthquake struck western Turkey on Sunday, killing 3 people and injuring 29 others, officials said.\n\n"
      + "The quake was centered in the town of Sindirgi in Balikesir province, the disaster agency AFAD said. "
      + "Interior Minister Ali Yerlikaya said: “Search and rescue work is continuing at 16 buildings.” "
      + "Some 2.5 million people live in the province. Five hundred homes were checked in Sindirgi.",
  },
  {
    url: RT, via: "http",
    text: "Turkey's AFAD said 505 people were treated in hospitals after the quake in Balikesir.\u00a0Tremors were felt in Istanbul, about 200 km away.",
  },
];
const OPTS: CheckOptions = { now: new Date("2026-11-01T20:00:00Z"), allowedHosts: ["apnews.com", "reuters.com"], maxLeadAgeHours: 36 };

const GOOD: Storyboard = {
  version: 1, date: "2026-11-01", storyIndex: 1, countryCode: "TR",
  hook: "3 dead after 6.1 quake in Turkey",
  whyPicked: "test",
  lines: [
    {
      id: "l1", kind: "fact", say: "A magnitude 6.1 earthquake hit western Turkey on Sunday, killing three people.",
      visual: { kind: "map_zoom", places: ["Turkey", "Sindirgi"] },
      source: { outlet: "AP", url: AP, quote: "A magnitude 6.1 earthquake struck western Turkey on Sunday, killing 3 people and injuring 29 others, officials said.", publishedAt: "2026-11-01T08:00:00Z" },
    },
    {
      id: "l2", kind: "fact", say: "It was centered in the town of Sindirgi in Balikesir province.",
      visual: { kind: "route", from: "Balikesir", to: "Sindirgi" },
      source: { outlet: "AP", url: AP, quote: "The quake was centered in the town of Sindirgi in Balikesir province, the disaster agency AFAD said." },
    },
    {
      id: "l3", kind: "fact", say: "Hospitals treated 505 people after the quake, officials said.",
      visual: { kind: "counter", value: 505, label: "treated in hospitals" },
      source: { outlet: "Reuters", url: RT, quote: "Turkey's AFAD said 505 people were treated in hospitals after the quake in Balikesir. Tremors were felt in Istanbul, about 200 km away." },
    },
    {
      id: "l4", kind: "fact", say: "The interior minister said rescuers were still searching 16 buildings.",
      visual: { kind: "quote_card", who: "Ali Yerlikaya", text: "Search and rescue work is continuing at 16 buildings" },
      source: { outlet: "AP", url: AP, quote: 'Interior Minister Ali Yerlikaya said: "Search and rescue work is continuing at 16 buildings."' },
    },
    {
      id: "l5", kind: "framing", say: "So far, 3 people have died and 505 needed hospital care.",
      visual: { kind: "bars", items: [{ label: "Died", value: 3 }, { label: "Treated", value: 505 }] },
    },
  ],
};

const clone = (): Storyboard => structuredClone(GOOD);
const line = (sb: Storyboard, id: string): StoryLine => sb.lines.find(l => l.id === id)!;
const run = (sb: Storyboard, docs = DOCS, opts = OPTS) => checkFacts(sb, docs, opts);
function expectError(sb: Storyboard, prefix: string, re: RegExp, docs = DOCS, opts = OPTS) {
  const { errors } = run(sb, docs, opts);
  assert.ok(errors.some(e => e.startsWith(`${prefix}: `) && re.test(e)), `期待した誤り ${prefix} ${re} が無い:\n${errors.join("\n")}`);
}

test("checkFacts: 正しい台本は誤りも注意も無い", () => {
  const r = run(clone());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("checkFacts: 別の行の引用文にしか無い数は通さない", () => {
  const sb = clone();
  line(sb, "l3").say = "Hospitals treated 505 people, and 29 were injured.";
  expectError(sb, "l3", /数 29 が引用文に無い/);
  assert.ok(!run(sb).errors.some(e => e.startsWith("l1:")));
});

test("checkFacts: 語で書いた数と引用文の数字", () => {
  const ok = clone();
  line(ok, "l1").say = "A magnitude 6.1 earthquake hit western Turkey on Sunday, killing 3 people.";
  assert.deepEqual(run(ok).errors, []);

  const hundred = clone();
  line(hundred, "l3").say = "Hospitals treated five hundred people after the quake, officials said.";
  expectError(hundred, "l3", /数 5 が引用文に無い.*語で書いた数/);

  const pronoun = clone();
  line(pronoun, "l3").say = "Hospitals treated 505 people in one of the worst days.";
  expectError(pronoun, "l3", /数 1 が引用文に無い.*語で書いた数/);

  const half = clone();
  const h = line(half, "l2");
  h.source!.quote = "Some 2.5 million people live in the province. Five hundred homes were checked in Sindirgi.";
  h.say = "Half a million people live near Sindirgi, officials said.";
  expectError(half, "l2", /数 half が引用文に無い/);

  // 引用文の "Five hundred" と台本の "5 hundred" は数も桁も同じ。桁が違えば通さない。
  const scale = clone();
  const l = line(scale, "l2");
  l.say = "It was centered in Sindirgi, where 5 hundred homes collapsed.";
  l.source!.quote = "Some 2.5 million people live in the province. Five hundred homes were checked in Sindirgi.";
  assert.deepEqual(run(scale).errors.filter(e => e.startsWith("l2:")), []);
  l.say = "It was centered in Sindirgi, where 5 thousand homes collapsed.";
  expectError(scale, "l2", /数 5 thousand が引用文に無い/);
});

test("checkFacts: 桁（million / billion）の食い違いを通さない", () => {
  const sb = clone();
  const l = line(sb, "l2");
  l.source!.quote = "Some 2.5 million people live in the province. Five hundred homes were checked in Sindirgi.";
  l.say = "Some 2.5 billion people live in Balikesir province.";
  expectError(sb, "l2", /数 2\.5 billion が引用文に無い/);
  l.say = "About 2.5m people live in Balikesir province near Sindirgi.";
  assert.deepEqual(run(sb).errors.filter(e => e.startsWith("l2:")), []);
});

test("checkFacts: 省略記号のある引用文は通さない", () => {
  for (const q of [
    "A magnitude 6.1 earthquake struck western Turkey ... killing 3 people",
    "A magnitude 6.1 earthquake struck western Turkey… killing 3 people",
  ]) {
    const sb = clone();
    line(sb, "l1").source!.quote = q;
    expectError(sb, "l1", /省略/);
  }
});

test("checkFacts: クエリ付きの別 URL で取った本文は同じ記事として扱う", () => {
  const docs = DOCS.map(d => d.url === AP ? { ...d, url: "http://www.apnews.com/article/turkey-earthquake-sindirgi-abc123/?utm_source=x#top" } : d);
  assert.deepEqual(run(clone(), docs).errors, []);

  const other = DOCS.map(d => d.url === AP ? { ...d, url: "https://apnews.com/article/some-other-story" } : d);
  expectError(clone(), "l1", /本文を取得していない/, other);
});

test("checkFacts: 本文に無い引用文・曲がった引用符や nbsp の違いは同じ文", () => {
  const sb = clone();
  line(sb, "l1").source!.quote = "A magnitude 6.1 earthquake struck western Turkey on Sunday, killing 4 people.";
  line(sb, "l1").say = "A magnitude 6.1 earthquake hit western Turkey on Sunday, killing 4 people.";
  expectError(sb, "l1", /引用文が出典の本文に無い/);

  // 本文は “ ” と nbsp、引用文は " と普通の空白
  const ok = clone();
  line(ok, "l3").source!.quote = "505 people were treated in hospitals after the quake in Balikesir. Tremors were felt in Istanbul";
  assert.deepEqual(run(ok).errors, []);
});

test("checkFacts: 引用文の長さ", () => {
  const short = clone();
  line(short, "l2").source!.quote = "Balikesir province";
  expectError(short, "l2", /引用文の長さ/);
  const long = clone();
  line(long, "l2").source!.quote = "x".repeat(401);
  expectError(long, "l2", /引用文の長さ/);
});

test("checkFacts: 見出しの数は事実の文で読み上げた数だけ", () => {
  const sb = clone();
  sb.hook = "29 hurt in Turkey quake";
  expectError(sb, "hook", /数 29 が事実の文で確かめた数に無い/);

  const noDigit = clone();
  noDigit.hook = "Three dead in Turkey quake";
  expectError(noDigit, "hook", /数字から始まっていない/);

  const long = clone();
  long.hook = "3 dead after a 6.1 quake in western Turkey on Sunday";
  expectError(long, "hook", new RegExp(`上限 ${LIMITS.maxHookChars}`));
});

test("checkFacts: framing が新しい数を持ち込まない・出典を持たない", () => {
  const sb = clone();
  line(sb, "l5").say = "Experts expect 40 more aftershocks in the coming days.";
  expectError(sb, "l5", /数 40 が事実の文で確かめた数に無い/);

  const quoteOnly = clone();
  line(quoteOnly, "l5").say = "That leaves 29 people hurt and 505 in hospital care.";
  expectError(quoteOnly, "l5", /数 29/);

  const withSource = clone();
  line(withSource, "l5").source = { outlet: "AP", url: AP, quote: GOOD.lines[0].source!.quote };
  expectError(withSource, "l5", /framing に source/);
});

test("checkFacts: 引用カードの文は引用文の一部", () => {
  const sb = clone();
  line(sb, "l4").visual = { kind: "quote_card", who: "Ali Yerlikaya", text: "Rescue work is now over" };
  expectError(sb, "l4", /引用カード/);

  const partial = clone();
  line(partial, "l4").visual = { kind: "quote_card", who: "Ali Yerlikaya", text: "earch and rescue" };
  expectError(partial, "l4", /引用カード/);

  const noWho = clone();
  line(noWho, "l4").visual = { kind: "quote_card", who: " ", text: "Search and rescue work is continuing" };
  expectError(noWho, "l4", /who/);

  const framing = clone();
  line(framing, "l5").visual = { kind: "quote_card", who: "Ali Yerlikaya", text: "Search and rescue work is continuing at 16 buildings" };
  assert.deepEqual(run(framing).errors, []);

  const smuggle = clone();
  line(smuggle, "l4").visual = { kind: "quote_card", who: "Ali Yerlikaya (40 missing)", text: "Search and rescue work is continuing" };
  expectError(smuggle, "l4", /who.*数 40/);
});

test("checkFacts: 地図と経路の地名はどれかの引用文に語として出てくる", () => {
  const sb = clone();
  line(sb, "l1").visual = { kind: "map_zoom", places: ["Turkey", "Ankara"] };
  expectError(sb, "l1", /地名 Ankara/);

  const partial = clone();
  line(partial, "l1").visual = { kind: "map_zoom", places: ["Turk"] };
  expectError(partial, "l1", /地名 Turk/);

  const tooMany = clone();
  line(tooMany, "l1").visual = { kind: "map_zoom", places: ["Turkey", "Sindirgi", "Balikesir", "Istanbul", "Turkey", "Sindirgi"] };
  expectError(tooMany, "l1", /地名の数/);

  const route = clone();
  line(route, "l2").visual = { kind: "route", from: "Sindirgi", to: "Izmir" };
  expectError(route, "l2", /地名 Izmir/);
});

test("checkFacts: 1つ目の事実の記事が古ければ誤り（公開日時が分かるときだけ）", () => {
  const sb = clone();
  line(sb, "l1").source!.publishedAt = "2026-10-29T00:00:00Z";
  expectError(sb, "l1", /時間前/);

  const unknown = clone();
  delete line(unknown, "l1").source!.publishedAt;
  line(unknown, "l2").source!.publishedAt = "2020-01-01T00:00:00Z";
  assert.deepEqual(run(unknown).errors, []);

  const garbage = clone();
  line(garbage, "l1").source!.publishedAt = "Sunday morning";
  assert.deepEqual(run(garbage).errors, []);
});

test("checkFacts: 出典のホストは許可した媒体だけ（似た名前のホストは通さない）", () => {
  for (const url of ["https://evilapnews.com/article/x", "https://apnews.com.evil.example/article/x", "ftp://apnews.com/x", "not a url"]) {
    const sb = clone();
    line(sb, "l2").source!.url = url;
    const docs = [...DOCS, { url, via: "http" as const, text: DOCS[0].text }];
    expectError(sb, "l2", /ホスト|URL/, docs);
  }
  const sub = clone();
  line(sub, "l2").source!.url = "https://news.apnews.com/article/x";
  assert.deepEqual(run(sub, [...DOCS, { url: "https://news.apnews.com/article/x", via: "http", text: DOCS[0].text }]).errors, []);
});

test("checkFacts: counter と bars の値は確かめた数", () => {
  const sb = clone();
  line(sb, "l3").visual = { kind: "counter", value: 29, label: "treated" };
  expectError(sb, "l3", /counter の値 29/);

  const scale = clone();
  line(scale, "l3").visual = { kind: "counter", value: 505, label: "thousand treated" };
  expectError(scale, "l3", /505 thousand/);

  const notNumber = clone();
  line(notNumber, "l3").visual = { kind: "counter", value: Number.NaN, label: "treated" };
  expectError(notNumber, "l3", /counter の値/);

  const bars = clone();
  line(bars, "l5").visual = { kind: "bars", items: [{ label: "Died", value: 3 }, { label: "Hurt", value: 29 }] };
  expectError(bars, "l5", /bars の値 29/);

  const barLabel = clone();
  line(barLabel, "l5").visual = { kind: "bars", items: [{ label: "Died", value: 3 }, { label: "In 2024", value: 505 }] };
  expectError(barLabel, "l5", /2024/);

  const few = clone();
  line(few, "l5").visual = { kind: "bars", items: [{ label: "Died", value: 3 }] };
  expectError(few, "l5", /bars の項目/);
});

test("checkFacts: 行数・語数・事実の文の数・id・version", () => {
  const few = clone();
  few.lines = few.lines.slice(0, 3);
  expectError(few, "全体", /文の数 3/);

  const facts = clone();
  line(facts, "l2").kind = "framing";
  delete line(facts, "l2").source;
  line(facts, "l3").kind = "framing";
  delete line(facts, "l3").source;
  expectError(facts, "全体", /事実の文 2 本/);

  const wordy = clone();
  line(wordy, "l2").say = "It was centered in the small rural town of Sindirgi in the western Balikesir province.";
  expectError(wordy, "l2", /語数 15/);

  const total = clone();
  for (const l of total.lines) l.say = l.say.split(" ").slice(0, 8).join(" ");
  expectError(total, "全体", /語数/);

  const dup = clone();
  line(dup, "l2").id = "l1";
  expectError(dup, "l1", /重複/);

  const v = clone() as unknown as { version: number };
  v.version = 2;
  expectError(v as unknown as Storyboard, "全体", /version/);
});

test("checkFacts: 壊れた入力でも例外を投げずに誤りを返す", () => {
  const broken = { version: 1, hook: 5, lines: [{ id: "l1", kind: "fact", say: "x" }, { id: "l2", kind: "other", say: 3, visual: { kind: "spin" } }, null] } as unknown as Storyboard;
  const r = checkFacts(broken, DOCS, OPTS);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some(e => e.startsWith("l1: ") && /source/.test(e)));
  assert.ok(r.errors.some(e => e.startsWith("l2: ") && /kind/.test(e)));
  assert.deepEqual(checkFacts({} as Storyboard, [], OPTS).errors.length > 0, true);
});

test("checkFacts: 注意は誤りにしない（最後の文が見出しの数に戻らない・媒体が1つ）", () => {
  const sb = clone();
  line(sb, "l5").say = "So far, 505 people have needed hospital care in the region.";
  line(sb, "l5").visual = { kind: "counter", value: 505, label: "treated" };
  const r = run(sb);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => w.startsWith("l5: ") && /見出しの数 3/.test(w)));

  const one = clone();
  line(one, "l3").source = { outlet: "AP", url: AP, quote: "Some 2.5 million people live in the province. Five hundred homes were checked in Sindirgi." };
  line(one, "l3").say = "Some 2.5 million people live in the province, officials said.";
  line(one, "l3").visual = { kind: "counter", value: 2.5, label: "million residents" };
  line(one, "l5").say = "So far, 3 people have died and 16 buildings are searched.";
  line(one, "l5").visual = { kind: "bars", items: [{ label: "Died", value: 3 }, { label: "Buildings", value: 16 }] };
  const r2 = run(one);
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.warnings.some(w => /媒体/.test(w)));
});

const words = (texts: string[], step = 0.3): Word[] => {
  const out: Word[] = [];
  let t = 0.2;
  for (const w of texts) { out.push({ w, t, d: step - 0.05 }); t += step; }
  return out;
};
const L = (says: string[]): StoryLine[] => says.map((say, i) => ({ id: `l${i + 1}`, kind: "framing", say, visual: { kind: "counter", value: 1, label: "" } }));
const ranges = (beats: ReturnType<typeof alignBeats>) => beats.map(b => [b.from, b.to]);

test("alignBeats: 単語が台本どおりなら文ごとに区切る", () => {
  const lines = L(["A magnitude 6.1 earthquake hit.", "It was centered in Sindirgi.", "Doctors treated 505 people."]);
  const ws = words(["A", "magnitude", "6.1", "earthquake", "hit", "It", "was", "centered", "in", "Sindirgi", "Doctors", "treated", "505", "people"]);
  const beats = alignBeats(lines, ws);
  assert.deepEqual(beats.map(b => b.lineId), ["l1", "l2", "l3"]);
  assert.deepEqual(ranges(beats), [[0, 5], [5, 10], [10, 14]]);
  assert.equal(beats[0].start, ws[0].t);
  assert.equal(beats[0].end, ws[4].t + ws[4].d);
  assert.equal(beats[2].end, ws[13].t + ws[13].d);
});

test("alignBeats: 句読点・分かれた語・抜けた短い語・読み上げで伸びた数に強い", () => {
  const lines = L(["A magnitude 6.1 earthquake hit.", "It was centered in Sindirgi.", "Doctors treated 1,009 people."]);
  const split = alignBeats(lines, words(["A", "magnitude", "6", ".1", "earthquake", "hit", ".", "It", "was", "centered", "in", "Sindirgi", "Doctors", "treated", "1", ",009", "people"]));
  assert.deepEqual(ranges(split), [[0, 7], [7, 12], [12, 17]]);

  const dropped = alignBeats(lines, words(["magnitude", "6.1", "earthquake", "hit", "It", "was", "centered", "in", "Sindirgi", "Doctors", "treated", "1,009", "people"]));
  assert.deepEqual(ranges(dropped), [[0, 4], [4, 9], [9, 13]]);

  const spelled = alignBeats(lines, words(["A", "magnitude", "six", "point", "one", "earthquake", "hit", "It", "was", "centered", "in", "Sindirgi", "Doctors", "treated", "one", "thousand", "nine", "people"]));
  assert.deepEqual(ranges(spelled), [[0, 7], [7, 12], [12, 18]]);
});

test("alignBeats: 単語が尽きたら残りの文は末尾の長さ0、余った単語は最後の文に入る", () => {
  const lines = L(["A magnitude 6.1 earthquake hit.", "It was centered in Sindirgi.", "Doctors treated 505 people."]);
  const cut = words(["A", "magnitude", "6.1", "earthquake", "hit", "It", "was"]);
  const beats = alignBeats(lines, cut);
  assert.deepEqual(ranges(beats), [[0, 5], [5, 7], [7, 7]]);
  const endT = cut[6].t + cut[6].d;
  assert.equal(beats[2].start, endT);
  assert.equal(beats[2].end, endT);

  const tiny = alignBeats(lines, words(["A", "magnitude"]));
  assert.deepEqual(ranges(tiny), [[0, 2], [2, 2], [2, 2]]);

  const extra = words(["A", "magnitude", "6.1", "earthquake", "hit", "It", "was", "centered", "in", "Sindirgi", "Doctors", "treated", "505", "people", "Follow", "for", "more"]);
  const tail = alignBeats(lines, extra);
  assert.deepEqual(ranges(tail), [[0, 5], [5, 10], [10, 17]]);
  assert.equal(tail[2].end, extra[16].t + extra[16].d);

  assert.deepEqual(alignBeats(lines, []).map(b => [b.from, b.to, b.start, b.end]), [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
});

test("alignBeats: どの文も1つずつ・順番どおり・隙間なく、単語が残る間は空にしない", () => {
  const lines = L(["One.", "", "Two three four five six seven.", "Eight nine."]);
  const ws = words(["One", "Two", "three", "four", "five", "six", "seven", "Eight", "nine"]);
  const beats = alignBeats(lines, ws);
  assert.equal(beats.length, lines.length);
  assert.deepEqual(beats.map(b => b.lineId), lines.map(l => l.id));
  for (let i = 0; i < beats.length; i++) {
    assert.ok(beats[i].to > beats[i].from, `${beats[i].lineId} が空`);
    if (i) assert.equal(beats[i].from, beats[i - 1].to);
    assert.ok(beats[i].end >= beats[i].start);
  }
  assert.equal(beats[beats.length - 1].to, ws.length);
});

const EXP: Experiment = {
  id: "news-explainer-2026-11", title: "解説形式", status: "running", design: "randomized", lane: "news", unit: "video",
  arms: ["explainer", "legacy"], control: "legacy", armSource: { by: "hash" },
  window: { start: "2026-11-05", end: "2026-11-18", decideOn: "2026-11-26" },
  decide: { minN: 10, adoptIf: "ratio>=1.0" },
};
const HOOK: Experiment = { ...EXP, id: "hook-y", lane: "hook", unit: "day", arms: ["top", "legacy"], control: "legacy" };
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-11-${String(from + i).padStart(2, "0")}`);

test("styleFor: 期間中は乱数の腕、手動の指定が優先、期間外は legacy", () => {
  let explainer = 0;
  for (const d of days(5, 18)) for (let i = 1; i <= 3; i++) {
    const s = styleFor([EXP], d, i);
    assert.equal(s.by, "experiment");
    assert.equal(s.expId, EXP.id);
    assert.equal(s.style, assignArm(EXP, d, i));
    assert.deepEqual(styleFor([EXP], d, i), s);
    if (s.style === "explainer") explainer++;
  }
  assert.ok(explainer >= 10 && explainer <= 32, `腕の偏りが大きすぎる: ${explainer}/42`);

  assert.deepEqual(styleFor([EXP], "2026-11-06", 1, " ON "), { style: "explainer", by: "override", expId: EXP.id });
  assert.deepEqual(styleFor([EXP], "2026-11-06", 1, "legacy"), { style: "legacy", by: "override", expId: EXP.id });
  assert.deepEqual(styleFor([], "2026-11-06", 1, "on"), { style: "explainer", by: "override", expId: undefined });
  assert.equal(styleFor([EXP], "2026-11-06", 1, "").by, "experiment");

  assert.deepEqual(styleFor([EXP], "2026-11-04", 1), { style: "legacy", by: "default" });
  assert.deepEqual(styleFor([EXP], "2026-11-19", 1), { style: "legacy", by: "default" });
  assert.deepEqual(styleFor([{ ...EXP, status: "draft" }], "2026-11-06", 1), { style: "legacy", by: "default" });
  assert.deepEqual(styleFor([{ ...EXP, armSource: { by: "field", field: "format" } }], "2026-11-06", 1), { style: "legacy", by: "default" });
  assert.equal(explainerExperiment([{ ...EXP, arms: ["a", "b"] }], "2026-11-06"), undefined);

  assert.deepEqual(styleFor([{ ...EXP, status: "adopted" }], "2026-11-30", 2), { style: "explainer", by: "adopted" });
  assert.equal(storyboardFile(2, "US2"), "storyboard-2-us2.json");
});

test("finalizeArmRecord: 中身が原因の差し戻しは腕に残し、試みなかった本と手動の本は外す", () => {
  const exps = [EXP, HOOK];
  let d = "", idx = 0, decision: StyleDecision | undefined;
  outer: for (const day of days(5, 18)) for (let i = 1; i <= 3; i++) {
    const s = styleFor(exps, day, i);
    if (s.style === "explainer") { d = day; idx = i; decision = s; break outer; }
  }
  assert.ok(decision, "期間中に explainer の本が1本も無い");
  const rec = armRecordFor(exps, d, idx);
  assert.deepEqual(rec.exp, [EXP.id, HOOK.id]);
  assert.equal(rec.arm![EXP.id], "explainer");

  assert.deepEqual(finalizeArmRecord(rec, decision!, "ok", "explainer"), { ...rec, style: "explainer" });
  for (const s of ["check_failed", "refuted", "refusal", "no_docs"] as const) {
    const r = finalizeArmRecord(rec, decision!, s, "legacy");
    assert.deepEqual(r.exp, rec.exp, s);
    assert.equal(r.arm![EXP.id], "explainer");
    assert.equal(r.style, "legacy");
  }
  for (const s of ["cap", "disabled", "api_error", undefined] as const) {
    const r = finalizeArmRecord(rec, decision!, s, "legacy");
    assert.deepEqual(r.exp, [HOOK.id], String(s));
    assert.deepEqual(Object.keys(r.arm!), [HOOK.id]);
    assert.equal(r.variant, rec.variant);
    assert.equal(r.style, "legacy");
  }

  const solo = armRecordFor([EXP], d, idx);
  assert.deepEqual(finalizeArmRecord(solo, decision!, "cap", "legacy"), { variant: solo.variant, style: "legacy" });

  const manual = finalizeArmRecord(solo, styleFor([EXP], d, idx, "off"), "not_assigned", "legacy");
  assert.deepEqual(manual, { variant: solo.variant, style: "legacy" });

  let legacyDay = "", legacyIdx = 0;
  outer2: for (const day of days(5, 18)) for (let i = 1; i <= 3; i++) {
    if (styleFor([EXP], day, i).style === "legacy") { legacyDay = day; legacyIdx = i; break outer2; }
  }
  const lrec = armRecordFor([EXP], legacyDay, legacyIdx);
  const kept = finalizeArmRecord(lrec, styleFor([EXP], legacyDay, legacyIdx), "not_assigned", "legacy");
  assert.deepEqual(kept, { ...lrec, style: "legacy" });

  const none = armRecordFor([], "2026-11-30", 1);
  assert.deepEqual(finalizeArmRecord(none, styleFor([], "2026-11-30", 1), undefined, "legacy"), { variant: none.variant, style: "legacy" });
});
