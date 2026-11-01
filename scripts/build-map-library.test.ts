import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidate, CATALOG, numbersInLabel, parseSpec, type Ctx, type Loaded } from "./build-map-library.js";

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  date: "2026-11-01", thisYear: 2026, drawable: new Set(), usedIds: new Set(), usedTopics: [],
  names: new Map([["TCD", "Chad"], ["CIV", "Côte d'Ivoire"], ["GBR", "United Kingdom"]]),
  ...over,
});

const key = (i: number) => `C${String(i).padStart(3, "0")}`;

function numeric(values: number[], opts: { years?: number[]; year?: number; definition?: string } = {}): Loaded {
  const v = new Map<string, number>();
  const y = new Map<string, number>();
  values.forEach((x, i) => { v.set(key(i), x); y.set(key(i), opts.years?.[i] ?? opts.year ?? 2024); });
  return {
    id: "probe", kind: "numeric", name: "Probe indicator (% of population)", definition: opts.definition ?? "", topic: "X.Y",
    source: { name: "World Bank (X.Y)", url: "u", year: opts.year ?? 2024 }, dataUrl: "u", lastUpdated: null,
    values: v, years: y, integer: values.every(Number.isInteger), dropped: [], stale: [],
  };
}

function categorical(yes: number, no: number): Loaded {
  const v = new Map<string, string>();
  for (let i = 0; i < yes + no; i++) v.set(key(i), i < yes ? "yes" : "no");
  return {
    id: "probe", kind: "categorical", name: "Whether English is an official language",
    definition: "yes = English (eng) is in REST Countries' languages field (its list of official languages); no = it is not.", topic: "languages: eng",
    source: { name: "REST Countries v3.1 (languages: eng)", url: "https://restcountries.com/", year: 2026 }, dataUrl: "u", lastUpdated: "2026-02-25",
    values: v, years: new Map(), integer: false, dropped: [], stale: [],
  };
}

const pct = Array.from({ length: 200 }, (_, i) => i / 2);
const inflation = [...Array.from({ length: 14 }, (_, i) => -0.5 - i * 0.5), ...Array.from({ length: 186 }, (_, i) => (i * 30) / 186)];
const counts = Array.from({ length: 200 }, (_, i) => i % 11);

const words = { title: "SHARE OF PEOPLE BY COUNTRY", shortTitle: "Share of People in Every Country", cta: "Your country? 👇", unknownLabel: "No data", descriptionNote: "", skip: false, skipReason: "" };
const pctBins = [{ max: 25, label: "Under 25%" }, { max: 50, label: "25–50%" }, { max: 75, label: "50–75%" }, { max: null, label: "75%+" }];
const groups = [{ values: ["yes"], label: "Official language", muted: false }, { values: ["no"], label: "Not official", muted: true }];

function build(ds: Loaded, spec: Record<string, unknown>, c: Ctx = ctx()) {
  return buildCandidate(ds, parseSpec({ ...words, bins: [], groups: [], ...spec }, ds.id), c, "test");
}
function rejected(r: ReturnType<typeof build>): string {
  assert.ok(!("entry" in r), "expected a rejection");
  return r.reason;
}
function accepted(r: ReturnType<typeof build>) {
  assert.ok("entry" in r, "reason" in r ? r.reason : "");
  return r;
}

test("numbersInLabel: 英単語の数と全角数字も数え、単位の後ろの thousand は二重に数えない", () => {
  assert.deepEqual(numbersInLabel("Under 1M"), [1e6]);
  assert.deepEqual(numbersInLabel("10k–100k"), [1e4, 1e5]);
  assert.deepEqual(numbersInLabel("-2% to 0%"), [-2, 0]);
  assert.deepEqual(numbersInLabel("10 thousand people"), [1e4]);
  assert.deepEqual(numbersInLabel("ONE IN FOUR"), [1, 4]);
  assert.deepEqual(numbersInLabel("Nine in ten"), [9, 10]);
  assert.deepEqual(numbersInLabel("twenty-one"), [20, 1]);
  assert.deepEqual(numbersInLabel("about half"), [0.5]);
  assert.deepEqual(numbersInLabel("ＴＯＰ ２１"), [21]);
  assert.deepEqual(numbersInLabel("Often someone in km²"), []);
});

test("凡例: 負の値がある先頭ビンに「0–2%」は落ち、負の値が無ければ通る", () => {
  const bins = [{ max: 2, label: "0–2%" }, { max: 5, label: "2–5%" }, { max: 10, label: "5–10%" }, { max: null, label: "10% or more" }];
  assert.match(rejected(build(numeric(inflation), { bins })), /label "0–2%" has 0 .*goes down to -7/);
  accepted(build(numeric(inflation.map(Math.abs)), { bins }));
  accepted(build(numeric(inflation), { bins: [{ max: 2, label: "Under 2%" }, ...bins.slice(1)] }));
  assert.match(rejected(build(numeric(inflation), { bins: [{ max: 2, label: "-1–2%" }, ...bins.slice(1)] })), /has -1/);
});

test("凡例: 整数の 3 未満のビンに「Under 2」は落ち、「0–2」「Under 3」は通る", () => {
  const rest = [{ max: 6, label: "3–5" }, { max: 9, label: "6–8" }, { max: null, label: "9+" }];
  assert.match(rejected(build(numeric(counts), { bins: [{ max: 3, label: "Under 2" }, ...rest] })), /label "Under 2" has 2/);
  accepted(build(numeric(counts), { bins: [{ max: 3, label: "0–2" }, ...rest] }));
  accepted(build(numeric(counts), { bins: [{ max: 3, label: "Under 3" }, ...rest] }));
  accepted(build(numeric(counts), { bins: [{ max: 1, label: "0" }, { max: 3, label: "1–2" }, { max: 5, label: "3–4" }, { max: null, label: "5 or more" }] }));
});

test("凡例: 先頭に「or more」、最後に「Under」、中間に「Under」を書くと落ちる", () => {
  accepted(build(numeric(pct), { bins: pctBins }));
  assert.match(rejected(build(numeric(pct), { bins: [{ max: 25, label: "25% or more" }, ...pctBins.slice(1)] })), /first bin label "25% or more" reads as an upper bin/);
  assert.match(rejected(build(numeric(pct), { bins: [...pctBins.slice(0, 3), { max: null, label: "Under 75%" }] })), /last bin label "Under 75%" reads as a lower bin/);
  assert.match(rejected(build(numeric(pct), { bins: [pctBins[0], { max: 50, label: "Under 50%" }, ...pctBins.slice(2)] })), /middle bin label "Under 50%" reads as open-ended/);
  assert.match(rejected(build(numeric(pct), { bins: [pctBins[0], { max: 50, label: "25–60%" }, ...pctBins.slice(2)] })), /has 60/);
});

test("カテゴリの凡例と unknownLabel に数を書くと落ちる (件数は MapShort が描く)", () => {
  accepted(build(categorical(149, 101), { groups }));
  assert.match(rejected(build(categorical(149, 101), { groups: [{ ...groups[0], label: "Official (about 190)" }, groups[1]] })), /group label "Official \(about 190\)" has number\(s\) 190/);
  assert.match(rejected(build(categorical(149, 101), { groups: [{ ...groups[0], label: "Official in two" }, groups[1]] })), /group label .* has number\(s\) 2/);
  assert.match(rejected(build(categorical(149, 101), { groups, unknownLabel: "No data (32)" })), /unknownLabel "No data \(32\)" has number\(s\) 32/);
  assert.match(rejected(build(numeric(pct), { bins: pctBins, unknownLabel: "No data (32)" })), /unknownLabel "No data \(32\)"/);
});

test("見出し・CTA・補足は英単語の数と全角数字も定義・切れ目にあるものだけ", () => {
  const ds = numeric(pct);
  assert.match(rejected(build(ds, { bins: pctBins, title: "ONE IN FOUR COUNTRIES LACK FULL POWER" })), /title has number\(s\) 4/);
  assert.match(rejected(build(ds, { bins: pctBins, cta: "Nine in ten have it 👇" })), /cta has number\(s\) 9, 10/);
  assert.match(rejected(build(ds, { bins: pctBins, descriptionNote: "About half of countries are fully covered." })), /descriptionNote has number\(s\) 0\.5/);
  assert.match(rejected(build(ds, { bins: pctBins, title: "ＴＯＰ ２１ WITHOUT POWER" })), /title has number\(s\) 21/);
  accepted(build(ds, { bins: pctBins, cta: "Name one without looking 👇" }));
  accepted(build(ds, { bins: pctBins, cta: "Is yours one of them? 👇" }));
  accepted(build(numeric(pct, { definition: "Deaths per 1,000 live births." }), { bins: pctBins, title: "DEATHS PER THOUSAND BIRTHS" }));
});

test("見出し・CTA・凡例に国名を書くと落ちる", () => {
  const ds = numeric(pct);
  assert.match(rejected(build(ds, { bins: pctBins, cta: "Beat Chad? 👇" })), /cta names a country \("Chad"\)/);
  assert.match(rejected(build(ds, { bins: pctBins, title: "CÔTE D'IVOIRE AND THE REST" })), /title names a country/);
  assert.match(rejected(build(categorical(149, 101), { groups: [{ ...groups[0], label: "Like United Kingdom" }, groups[1]] })), /legend label names a country/);
  accepted(build(ds, { bins: pctBins, cta: "Chadwick would know 👇" }));
});

test("年: 1 か国でも年が違えば descriptionNote に注記し、全部同じ年なら注記しない", () => {
  // 最多年が 94% (drinking-water と同じくらい) でも注記する
  const years = pct.map((_, i) => (i < 12 ? 2016 + (i % 8) : 2024));
  const mixed = accepted(build(numeric(pct, { years, year: 2024 }), { bins: pctBins, descriptionNote: "Share of people." }));
  assert.equal(mixed.entry.descriptionNote, "Share of people. Latest available year per economy (2016–2024).");
  const one = accepted(build(numeric(pct, { years: pct.map((_, i) => (i === 0 ? 2019 : 2024)), year: 2024 }), { bins: pctBins }));
  assert.equal(one.entry.descriptionNote, "Latest available year per economy (2019–2024).");
  const same = accepted(build(numeric(pct, { year: 2024 }), { bins: pctBins }));
  assert.equal(same.entry.descriptionNote, undefined);
});

test("年: 最も多い年がちょうど 5 年前なら警告し、4 年前なら警告しない", () => {
  const five = accepted(build(numeric(pct, { year: 2021 }), { bins: pctBins }));
  assert.deepEqual(five.review.warnings, ["most values are from 2021"]);
  const four = accepted(build(numeric(pct, { year: 2022 }), { bins: pctBins }));
  assert.deepEqual(four.review.warnings, []);
});

test("CATALOG: REST の値が大国で誤る郵便番号の有無と公用語の数は入れない", () => {
  const ids = CATALOG.map(d => d.id);
  assert.ok(!ids.includes("postal-codes"));
  assert.ok(!ids.includes("official-languages-count"));
  assert.equal(CATALOG.filter(d => "rest" in d).length, 6);
  assert.equal(CATALOG.filter(d => "wb" in d).length, 77);
});

test("notes: 行った検査だけを書き、REST 由来は REST 以外の出典と照らさせる", () => {
  const cat = accepted(build(categorical(149, 101), { groups }));
  assert.match(cat.entry.notes, /group labels carry no numbers/);
  assert.doesNotMatch(cat.entry.notes, /bin's edges/);
  assert.match(cat.entry.notes, /NOT yet human-verified: spot-check 3 countries against a source other than REST Countries/);
  const num = accepted(build(numeric(pct), { bins: pctBins }));
  assert.match(num.entry.notes, /legend numbers are their bin's edges and the first\/last labels point the right way/);
  assert.match(num.entry.notes, /NOT yet human-verified: spot-check 3 countries against the source before/);
});
