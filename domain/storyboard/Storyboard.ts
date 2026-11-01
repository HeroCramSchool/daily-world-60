/**
 * 解説形式の本編（news-explainer）の台本。外部依存なし。
 * Claude の出力をこの形で受け、checkFacts で出典の本文と照合してから描画に渡す。
 * 事実の文（fact）は取得したページの文を1つ引用し、読み上げる数字はすべてその引用文に含まれていなければならない。
 */

export type Visual =
  | { kind: "map_zoom"; places: string[] }
  | { kind: "counter"; value: number; label: string }
  | { kind: "bars"; items: Array<{ label: string; value: number }> }
  | { kind: "route"; from: string; to: string }
  | { kind: "quote_card"; who: string; text: string };

export type VisualKind = Visual["kind"];

export type SourceRef = {
  outlet: string;
  url: string;
  /** 取得したページの本文からそのまま写した文。 */
  quote: string;
  /** 記事の公開日時（ISO 8601）。ページに書いてあるときだけ。 */
  publishedAt?: string;
};

export type StoryLine = {
  id: string;
  kind: "fact" | "framing";
  /** 読み上げる1文。 */
  say: string;
  visual: Visual;
  /** fact は必須。framing は持たない。 */
  source?: SourceRef;
};

export type Storyboard = {
  version: 1;
  date: string;
  storyIndex: number;
  countryCode: string;
  /** 画面の見出し。数字から始める。 */
  hook: string;
  lines: StoryLine[];
  /** 編集担当がこの切り口を選んだ理由。 */
  whyPicked: string;
};

export type FetchedDoc = {
  url: string;
  title?: string;
  text: string;
  retrievedAt?: string;
  via: "web_fetch" | "http";
};

export type CheckOptions = {
  now: Date;
  /** 出典の URL のホストがこのどれかで終わること（例 "apnews.com"）。 */
  allowedHosts: string[];
  /** 1つ目の事実の文の記事がこれより古ければ誤り（公開日時が分かるときだけ）。 */
  maxLeadAgeHours: number;
};

export type CheckResult = { errors: string[]; warnings: string[] };

export const LIMITS = {
  minLines: 4,
  maxLines: 7,
  minFactLines: 3,
  maxWordsPerLine: 14,
  minTotalWords: 45,
  maxTotalWords: 80,
  maxHookChars: 40,
  maxBars: 4,
  minBars: 2,
  maxQuoteCardWords: 25,
} as const;

/**
 * 照合用に文字列をそろえる。NFKC、曲がった引用符→直線、各種ダッシュ→"-"、
 * nbsp などの空白→1つの半角空白、前後の空白を落とし、小文字にする。
 * ゼロ幅の文字も空白にする。ソフトハイフン（U+00AD）は落とす。"…" は NFKC で "..." になる。
 */
export function normalizeText(s: string): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/\u00AD/g, "")
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 文に出てくる数を正規化した文字列で返す（重複は除く・出てきた順）。
 * "1,200"→"1200"、"3.50"→"3.5"、"40%"→"40"、"$94bn"→"94"、"1st"→"1"、"50-60"→"50","60"。
 * 語は "zero"〜"nineteen"・"twenty"〜"ninety"（"twenty-five"→"25"、"twenty-first"→"21"）・"dozen"→"12" だけを数にする。
 * "1.2 million" は "1.2"、"five hundred" は "5"、"a million" は "1"（桁の語は返さない。桁は checkFacts が別に照合するので、
 * "five hundred" が引用文の "5" や "500" に一致して通ることは無い）。年（2026）も数として扱う。
 * 大まかな量の語（tens・dozens・hundreds・thousands・millions・billions・half・quarter）はそのまま返し、引用文にも同じ語を求める。
 */
export function numbersIn(s: string): string[] {
  return scanNumbers(s).plain;
}

/** 比較用の URL。スキーム・www・クエリ・#・末尾の / を落とし小文字にする。 */
export function canonicalUrl(url: string): string {
  return String(url ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const UNIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_WORDS = new Map([["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]);
const ORDINAL_UNITS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
const SCALE_WORDS = ["hundred", "thousand", "million", "billion", "trillion", "lakh", "crore", "dozen"];
const SCALE_ABBR = new Map([["k", "thousand"], ["m", "million"], ["mn", "million"], ["mln", "million"], ["b", "billion"], ["bn", "billion"], ["bln", "billion"], ["tn", "trillion"], ["trn", "trillion"]]);
const AMOUNT_WORDS = ["tens", "dozens", "hundreds", "thousands", "millions", "billions", "trillions", "half", "quarter"];
const NUMBER_TOKEN = /(?<![\p{L}\p{N}.])\.\d+|\d+(?:,\d{3}(?!\d))*(?:\.\d+)?|\p{L}+/gu;

type Tok = { s: string; num: boolean; gap: string };
/** plain は numbersIn の答え。scaled は桁の語つきの数（"1.2 million"、"5 hundred"）。 */
type Nums = { plain: string[]; scaled: string[] };

function canonNumber(raw: string): string {
  const [i, f = ""] = raw.replace(/,/g, "").split(".");
  const int = i.replace(/^0+(?=\d)/, "") || "0";
  const frac = f.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function tokenize(s: string): Tok[] {
  const t = normalizeText(s);
  const out: Tok[] = [];
  let end = 0;
  for (const m of t.matchAll(NUMBER_TOKEN)) {
    out.push({ s: m[0], num: /^[\d.]/.test(m[0]), gap: t.slice(end, m.index) });
    end = m.index! + m[0].length;
  }
  return out;
}

function scanNumbers(s: string): Nums {
  const toks = tokenize(s);
  const plain: string[] = [];
  const scaled: string[] = [];
  const push = (a: string[], v: string) => { if (!a.includes(v)) a.push(v); };
  const joined = (t?: Tok): t is Tok => !!t && !t.num && (t.gap === " " || t.gap === "-");
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    const next = toks[i + 1];
    let v: string | undefined;
    let j = i + 1;
    if (t.num) v = canonNumber(t.s);
    else if (UNIT_WORDS.includes(t.s)) v = String(UNIT_WORDS.indexOf(t.s));
    else if (TENS_WORDS.has(t.s)) {
      const u = joined(next) ? Math.max(UNIT_WORDS.indexOf(next.s), ORDINAL_UNITS.indexOf(next.s)) : -1;
      const unit = u >= 1 && u <= 9 ? u : 0;
      if (unit) j++;
      v = String(TENS_WORDS.get(t.s)! + unit);
    } else if (t.s === "dozen") v = "12";
    else if ((t.s === "a" || t.s === "an") && joined(next) && next.s !== "dozen" && SCALE_WORDS.includes(next.s)) {
      // "half a million" を "a million"（1 million）として通さない
      const prev = toks[i - 1];
      v = prev && t.gap === " " && (prev.s === "half" || prev.s === "quarter") ? prev.s : "1";
    } else if (AMOUNT_WORDS.includes(t.s)) push(plain, t.s);
    if (v === undefined) { i++; continue; }
    const names: string[] = [];
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.num) break;
      if (SCALE_WORDS.includes(x.s) && (x.gap === "" || x.gap === " " || x.gap === "-")) names.push(x.s);
      else if (!names.length && SCALE_ABBR.has(x.s) && (x.gap === "" || (x.gap === " " && x.s.length > 1))) names.push(SCALE_ABBR.get(x.s)!);
      else break;
    }
    push(plain, v);
    if (names.length) push(scaled, `${v} ${names.join(" ")}`);
    i = j;
  }
  return { plain, scaled };
}

/**
 * 台本を出典の本文と照合する。errors が1件でもあればその本は出さない。
 * - 行数・語数・見出しの長さ（LIMITS）
 * - fact: source 必須・ホストが allowedHosts・docs に同じ URL の本文がある・quote が本文に含まれる・say の数がすべて quote にある
 * - framing: source を持たない・数は fact の行で確かめた数だけ
 * - hook: 数字から始まり、数は fact の行で確かめた数だけ
 * - visual: counter/bars の値は確かめた数、quote_card の text はその行の quote の一部、
 *   map_zoom/route の地名はいずれかの fact の quote に出てくる
 * - 1つ目の fact の publishedAt が分かり maxLeadAgeHours より古ければ誤り
 * warnings: 最後の文が見出しの最初の数に戻っていない など
 * 数は numbersIn に加えて桁の語（million など）も照合する。「確かめた数」は fact の say の数のうち、その行の quote にあったもの。
 * 地名・引用カードの文は語の区切りで照合する（"Niger" は "Nigeria" に一致しない）。誤りの文は先頭に行の id を付ける。
 */
export function checkFacts(sb: Storyboard, docs: FetchedDoc[], opts: CheckOptions): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = (Array.isArray(sb?.lines) ? sb.lines : []) as Array<StoryLine | null | undefined>;
  const docList = Array.isArray(docs) ? docs : [];
  const allowed = (opts.allowedHosts ?? []).map(h => h.trim().toLowerCase().replace(/^\.+/, "").replace(/^www\./, "")).filter(Boolean);

  if (sb?.version !== 1) errors.push(`全体: version が 1 でない（${sb?.version}）`);
  if (lines.length < LIMITS.minLines || lines.length > LIMITS.maxLines) errors.push(`全体: 文の数 ${lines.length}（${LIMITS.minLines}〜${LIMITS.maxLines}）`);
  const facts = lines.filter((l): l is StoryLine => l?.kind === "fact");
  if (facts.length < LIMITS.minFactLines) errors.push(`全体: 事実の文 ${facts.length} 本（最低 ${LIMITS.minFactLines} 本）`);
  const total = lines.reduce((a, l) => a + wordCount(l?.say), 0);
  if (total < LIMITS.minTotalWords || total > LIMITS.maxTotalWords) errors.push(`全体: 語数 ${total}（${LIMITS.minTotalWords}〜${LIMITS.maxTotalWords}）`);

  const ids = lines.map((l, i) => (typeof l?.id === "string" && l.id.trim() ? l.id.trim() : `#${i + 1}`));
  const verified: NumSet = { plain: new Set(), scaled: new Set() };
  const trustedQuotes: string[] = [];
  const hosts = new Set<string>();
  const seen = new Set<string>();

  lines.forEach((l, i) => {
    const id = ids[i];
    if (!l || typeof l !== "object") { errors.push(`${id}: 文が無い`); return; }
    if (id.startsWith("#")) errors.push(`${id}: id が無い`);
    else if (seen.has(id)) errors.push(`${id}: id が重複している`);
    seen.add(id);
    const say = typeof l.say === "string" ? l.say : "";
    if (!say.trim()) errors.push(`${id}: say が空`);
    const words = wordCount(say);
    if (words > LIMITS.maxWordsPerLine) errors.push(`${id}: 語数 ${words}（上限 ${LIMITS.maxWordsPerLine}）`);
    if (l.kind === "framing") {
      if (l.source) errors.push(`${id}: framing に source がある（出典のある文は fact にする）`);
      return;
    }
    if (l.kind !== "fact") { errors.push(`${id}: kind が fact でも framing でもない（${String(l.kind)}）`); return; }

    const src = l.source;
    if (!src || typeof src !== "object") { errors.push(`${id}: 事実の文に source が無い`); return; }
    const quote = typeof src.quote === "string" ? src.quote : "";
    const nq = normalizeText(quote);
    let trusted = true;
    const fail = (m: string) => { errors.push(`${id}: ${m}`); trusted = false; };
    if (nq.length < 20 || nq.length > 400) fail(`引用文の長さ ${nq.length} 字（20〜400）`);
    if (/\.\s?\.\s?\./.test(nq)) fail("引用文に省略（... や …）がある。本文の連続した部分をそのまま写す");
    const host = hostOf(src.url);
    if (!host) fail(`出典の URL が読めない（${String(src.url)}）`);
    else {
      hosts.add(host);
      if (!allowed.some(a => host === a || host.endsWith(`.${a}`))) fail(`出典のホスト ${host} が許可した媒体に無い`);
    }
    const key = canonicalUrl(typeof src.url === "string" ? src.url : "");
    const same = docList.filter(d => typeof d?.url === "string" && canonicalUrl(d.url) === key);
    if (!same.length) fail(`出典 ${String(src.url)} の本文を取得していない`);
    else if (nq && !same.some(d => normalizeText(d.text ?? "").includes(nq))) fail(`引用文が出典の本文に無い「${quote.slice(0, 80)}」`);

    const q = toSet(scanNumbers(quote));
    const s = scanNumbers(say);
    for (const n of missingIn(s, q)) errors.push(`${id}: 数 ${n} が引用文に無い（引用文の数: ${listOf(q)}）${wordHint(say, n)}`);
    if (!trusted) return;
    trustedQuotes.push(nq);
    for (const n of s.plain) if (q.plain.has(n)) verified.plain.add(n);
    for (const n of s.scaled) if (q.scaled.has(n)) verified.scaled.add(n);
  });

  lines.forEach((l, i) => {
    if (!l || typeof l !== "object" || (l.kind !== "fact" && l.kind !== "framing")) return;
    const id = ids[i];
    const isFact = l.kind === "fact";
    const ownQuote = isFact && typeof l.source?.quote === "string" ? l.source.quote : "";
    const ref = isFact ? toSet(scanNumbers(ownQuote)) : verified;
    const where = isFact ? `引用文に無い（引用文の数: ${listOf(ref)}）` : `事実の文で確かめた数に無い（確かめた数: ${listOf(verified)}）`;
    const unverified = (text: string) => missingIn(scanNumbers(text), ref);
    const say = typeof l.say === "string" ? l.say : "";
    if (!isFact) for (const n of unverified(say)) errors.push(`${id}: 数 ${n} が${where}${wordHint(say, n)}`);

    const v = l.visual as Visual | undefined;
    if (!v || typeof v !== "object") { errors.push(`${id}: visual が無い`); return; }
    const placeOk = (p: unknown) => trustedQuotes.some(q => hasPhrase(q, p));
    switch (v.kind) {
      case "map_zoom": {
        const places: unknown[] = Array.isArray(v.places) ? v.places : [];
        if (places.length < 1 || places.length > 5) errors.push(`${id}: 地名の数 ${places.length}（1〜5）`);
        for (const p of places) if (!placeOk(p)) errors.push(`${id}: 地名 ${String(p)} がどの事実の引用文にも語として無い`);
        break;
      }
      case "route":
        for (const p of [v.from, v.to]) if (!placeOk(p)) errors.push(`${id}: 地名 ${String(p)} がどの事実の引用文にも語として無い`);
        break;
      case "counter": {
        if (typeof v.value !== "number" || !Number.isFinite(v.value)) { errors.push(`${id}: counter の値が数でない（${String(v.value)}）`); break; }
        const label = typeof v.label === "string" ? v.label : "";
        const own = numbersIn(String(v.value));
        if (!own.length) errors.push(`${id}: counter の値 ${v.value} を数として読めない`);
        for (const n of unverified(`${v.value} ${label}`)) {
          errors.push(own.includes(n) ? `${id}: counter の値 ${n} が${where}` : `${id}: counter の見出し「${label}」の数 ${n} が${where}`);
        }
        break;
      }
      case "bars": {
        const items: Array<{ label?: unknown; value?: unknown } | null> = Array.isArray(v.items) ? v.items : [];
        if (items.length < LIMITS.minBars || items.length > LIMITS.maxBars) errors.push(`${id}: bars の項目 ${items.length} 個（${LIMITS.minBars}〜${LIMITS.maxBars}）`);
        for (const it of items) {
          const label = typeof it?.label === "string" ? it.label : "";
          if (!label.trim()) errors.push(`${id}: bars の項目に label が無い`);
          if (typeof it?.value !== "number" || !Number.isFinite(it.value)) { errors.push(`${id}: bars の値が数でない（${label}）`); continue; }
          if (!numbersIn(String(it.value)).length) errors.push(`${id}: bars の値 ${it.value} を数として読めない`);
          for (const n of unverified(String(it.value))) errors.push(`${id}: bars の値 ${n} が${where}`);
          for (const n of unverified(label)) errors.push(`${id}: bars の見出し「${label}」の数 ${n} が${where}`);
        }
        break;
      }
      case "quote_card": {
        const text = typeof v.text === "string" ? v.text : "";
        if (typeof v.who !== "string" || !v.who.trim()) errors.push(`${id}: 引用カードの who が空`);
        else for (const n of unverified(v.who)) errors.push(`${id}: 引用カードの who「${v.who}」の数 ${n} が${where}`);
        const w = wordCount(text);
        if (!w) errors.push(`${id}: 引用カードの text が空`);
        else if (w > LIMITS.maxQuoteCardWords) errors.push(`${id}: 引用カードの語数 ${w}（上限 ${LIMITS.maxQuoteCardWords}）`);
        const quotes = isFact ? [normalizeText(ownQuote)] : trustedQuotes;
        if (w && !quotes.some(q => hasPhrase(q, text))) {
          errors.push(`${id}: 引用カードの文が${isFact ? "この行の引用文" : "どの事実の引用文"}の一部でもない「${text.slice(0, 60)}」`);
        }
        break;
      }
      default:
        errors.push(`${id}: visual の種類が不明（${String((v as { kind?: unknown }).kind)}）`);
    }
  });

  const hook = typeof sb?.hook === "string" ? sb.hook.trim() : "";
  if (!/^\d/.test(hook)) errors.push(`hook: 数字から始まっていない「${hook}」`);
  const hookLen = [...hook].length;
  if (hookLen > LIMITS.maxHookChars) errors.push(`hook: ${hookLen} 字（上限 ${LIMITS.maxHookChars} 字）`);
  const hookNums = scanNumbers(hook);
  for (const n of missingIn(hookNums, verified)) errors.push(`hook: 数 ${n} が事実の文で確かめた数に無い（確かめた数: ${listOf(verified)}）`);

  const lead = facts[0];
  const published = lead?.source?.publishedAt;
  // Date.parse は "Sunday, Nov 1" を 2001 年と読むので ISO 形式のときだけ使う
  const pubMs = typeof published === "string" && /^\d{4}-\d{2}-\d{2}/.test(published.trim()) ? Date.parse(published.trim()) : NaN;
  if (lead && Number.isFinite(pubMs)) {
    const hours = (opts.now.getTime() - pubMs) / 3_600_000;
    if (hours > opts.maxLeadAgeHours) errors.push(`${ids[lines.indexOf(lead)]}: 1つ目の事実の記事が ${Math.round(hours)} 時間前（上限 ${opts.maxLeadAgeHours} 時間）`);
  }

  const firstHookNum = hookNums.plain.find(n => /^\d/.test(n));
  const last = lines[lines.length - 1];
  if (firstHookNum && last && !numbersIn(typeof last.say === "string" ? last.say : "").includes(firstHookNum)) {
    warnings.push(`${ids[lines.length - 1]}: 最後の文が見出しの数 ${firstHookNum} に戻っていない`);
  }
  if (facts.length && hosts.size < 2) warnings.push(`全体: 出典の媒体が ${hosts.size} つだけ（${[...hosts].join(", ")}）`);
  return { errors, warnings };
}

type NumSet = { plain: Set<string>; scaled: Set<string> };
const toSet = (n: Nums): NumSet => ({ plain: new Set(n.plain), scaled: new Set(n.scaled) });
const missingIn = (sub: Nums, ref: NumSet) => [...sub.plain.filter(x => !ref.plain.has(x)), ...sub.scaled.filter(x => !ref.scaled.has(x))];
const listOf = (ref: NumSet) => [...new Set([...ref.plain, ...ref.scaled])].join(", ") || "なし";

/** 数字で書いていない数（"one"・"a million" など）で落ちたときに、直す側が気づけるようにする。 */
const wordHint = (text: string, n: string) => (/^\d/.test(n) && !normalizeText(text).includes(n.split(" ")[0]) ? "。語で書いた数（one・a million など）も数える" : "");

const hasAlnum = (s: string | undefined) => !!s && /[\p{L}\p{N}]/u.test(s);
const wordCount = (s: unknown) => (typeof s === "string" ? s.trim().split(/\s+/).filter(hasAlnum).length : 0);

function hasPhrase(hay: string, needle: unknown): boolean {
  const n = typeof needle === "string" ? normalizeText(needle) : "";
  if (!n) return false;
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) {
    const left = !hasAlnum(n[0]) || !hasAlnum(hay[i - 1]);
    const right = !hasAlnum(n[n.length - 1]) || !hasAlnum(hay[i + n.length]);
    if (left && right) return true;
  }
  return false;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export type Word = { w: string; t: number; d: number };
export type Beat = { lineId: string; start: number; end: number; from: number; to: number };

/**
 * 読み上げの単語の時刻を台本の文に割り当てる。words は lines の say を順に読んだもの。
 * 文ごとに正規化した文字数を積み上げて境界を決める（prep-short の sentenceBounds と同じ考え方）。
 * from/to は words のインデックス（to は含まない）。start は最初の語の t、end は最後の語の t+d。
 * 境界は文字数が最も近い位置にし、前後2語以内に「次の文の頭の語・この文の終わりの語」と合う位置があればそこへ寄せる
 * （句読点の有無・分かれた語・抜けた語・数の読み上げで文字数がずれても境界がずれない）。
 * 語が残る間はどの文にも1語以上を割り当て、最後の文は残りの語をすべて持つ。
 * 語が尽きたら残りの文は長さ0（from = to = words.length、start = end = 最後の語の t+d、語が無ければ 0）。
 */
export function alignBeats(lines: StoryLine[], words: Word[]): Beat[] {
  const norm = (s: unknown) => (typeof s === "string" ? normalizeText(s).replace(/[^\p{L}\p{N}]/gu, "") : "");
  const target = lines.map(l => norm(l?.say));
  const wn = words.map(w => norm(w?.w));
  const W = words.length;
  const endOf = (i: number) => words[i].t + words[i].d;
  const prevWord = (e: number) => {
    for (let i = e - 1; i >= 0; i--) if (wn[i]) return wn[i];
    return "";
  };
  const anchored = (k: number, e: number) => {
    if (e <= 0 || e >= W || !wn[e]) return false;
    const next = target.slice(k + 1).find(Boolean) ?? "";
    const prev = prevWord(e);
    return !!prev && next.startsWith(wn[e]) && target[k].endsWith(prev);
  };

  const beats: Beat[] = [];
  let p = 0;
  lines.forEach((l, k) => {
    let e = p;
    if (p < W && k === lines.length - 1) e = W;
    else if (p < W) {
      const want = target[k].length;
      let acc = wn[p].length;
      e = p + 1;
      while (e < W && acc < want) acc += wn[e++].length;
      const accPrev = acc - wn[e - 1].length;
      let best = e - 1 > p && Math.abs(accPrev - want) < Math.abs(acc - want) ? e - 1 : e;
      if (!anchored(k, best)) {
        const near = [best - 1, best + 1, best - 2, best + 2].find(c => c > p && c <= W && anchored(k, c));
        if (near !== undefined) best = near;
      }
      e = best;
    }
    const lineId = typeof l?.id === "string" ? l.id : `#${k + 1}`;
    if (e > p) beats.push({ lineId, start: words[p].t, end: endOf(e - 1), from: p, to: e });
    else {
      const t = W ? endOf(W - 1) : 0;
      beats.push({ lineId, start: t, end: t, from: p, to: p });
    }
    p = e;
  });
  return beats;
}
