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
  /** 事実の文の記事がこれより古ければ誤り。公開日時が分かる事実の文すべてに当てる（1つ目の文だけに当てていた頃の名前のまま）。 */
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
 * "1,200"→"1200"、"3.50"→"3.5"、"$94bn"→"94"、"1st"→"1"、"50-60"→"50","60"。
 * "40%"・"40 percent"・"40 per cent" は "40%"（"40" とは別の数）。
 * 語は "zero"〜"nineteen"・"twenty"〜"ninety"（"twenty-five"→"25"、"twenty-first"→"21"）・"dozen"→"12" を数にする。
 * 序数の語も数字にする（"third"→"3"、"fifth"→"5"。"5th" と同じ）。
 * "1.2 million" は "1.2"、"five hundred" は "5"、"a million" は "1"（桁の語は返さない。桁は checkFacts が別に照合するので、
 * "five hundred" が引用文の "5" や "500" に一致して通ることは無い）。年（2026）も数として扱う。
 * 大まかな量の語（tens・dozens・hundreds・thousands・millions・billions・half・quarter）と
 * 倍数・分数・増減の語（twice・doubled→"double"・tripled→"triple"・halved・thirds・"tenfold"/"10-fold"→"10fold"）はそのまま返し、
 * 引用文にも同じ語を求める。
 * 文字に数字が続く型番・名前（"F-16"・"Shahed-136"・"Kh-101"・"S-300"・"G7"）は数にせず、その語のまま返す（"f-16"）。
 * ただし "post-2022"・"under-18s"・"mid-2025" のような前に付く語の後の数字は数のまま。
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
const ORDINAL_WORDS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];
const ORDINAL_TENS = new Map([["twentieth", 20], ["thirtieth", 30], ["fortieth", 40], ["fiftieth", 50], ["sixtieth", 60], ["seventieth", 70], ["eightieth", 80], ["ninetieth", 90], ["hundredth", 100], ["thousandth", 1000]]);
const SCALE_WORDS = ["hundred", "thousand", "million", "billion", "trillion", "lakh", "crore", "dozen"];
const SCALE_ABBR = new Map([["k", "thousand"], ["m", "million"], ["mn", "million"], ["mln", "million"], ["b", "billion"], ["bn", "billion"], ["bln", "billion"], ["tn", "trillion"], ["trn", "trillion"]]);
const AMOUNT_WORDS = ["tens", "dozens", "hundreds", "thousands", "millions", "billions", "trillions", "half", "quarter"];
const CHANGE_WORDS = new Map<string, string>([
  ["twice", "twice"], ["thrice", "thrice"], ["thirds", "thirds"], ["quarters", "quarters"],
  ...["double", "doubled", "doubles", "doubling"].map(w => [w, "double"] as [string, string]),
  ...["triple", "tripled", "triples", "tripling"].map(w => [w, "triple"] as [string, string]),
  ...["quadruple", "quadrupled", "quadruples", "quadrupling"].map(w => [w, "quadruple"] as [string, string]),
  ...["halve", "halved", "halves", "halving"].map(w => [w, "halved"] as [string, string]),
]);
// 型番（f-16・shahed-136・g7）は1語。前に付く語（post-2022・under-18s）の後の数字は数のまま
const NUMBER_TOKEN = /(?<![\p{L}\p{N}.])\.\d+(?: ?%)?|\d+(?:,\d{3}(?!\d))*(?:\.\d+)?(?: ?%)?|(?!(?:pre|post|mid|under|over|non|anti|late|early|top|sub|ex|up|near)-\d)\p{L}+-\d+(?:\p{L}+\d+)*|\p{L}{1,3}\d+(?:\p{L}+\d+)*|\p{L}+/gu;

type Tok = { s: string; num: boolean; code: boolean; gap: string };
/** plain は numbersIn の答え。scaled は桁の語つきの数（"1.2 million"、"5 hundred"）。raw は数ごとの文中の書き方（"one"・"five hundred"）。 */
type Nums = { plain: string[]; scaled: string[]; raw: Map<string, string> };

function canonNumber(raw: string): string {
  const pct = raw.endsWith("%");
  const [i, f = ""] = raw.replace(/ ?%$/, "").replace(/,/g, "").split(".");
  const int = i.replace(/^0+(?=\d)/, "") || "0";
  const frac = f.replace(/0+$/, "");
  return (frac ? `${int}.${frac}` : int) + (pct ? "%" : "");
}

function tokenize(s: string): Tok[] {
  const t = normalizeText(s);
  const out: Tok[] = [];
  let end = 0;
  for (const m of t.matchAll(NUMBER_TOKEN)) {
    const num = /^[\d.]/.test(m[0]);
    out.push({ s: m[0], num, code: !num && /\d/.test(m[0]), gap: t.slice(end, m.index) });
    end = m.index! + m[0].length;
  }
  return out;
}

/** "tenfold"→"10fold"。数の語で始まらない "unfold"・"manifold" は数にしない。 */
function foldOf(w: string): string | undefined {
  const m = /^(\p{L}+)fold$/u.exec(w);
  if (!m) return undefined;
  const u = UNIT_WORDS.indexOf(m[1]);
  const n = u >= 2 ? u : TENS_WORDS.get(m[1]) ?? (m[1] === "hundred" ? 100 : m[1] === "thousand" ? 1000 : undefined);
  return n === undefined ? undefined : `${n}fold`;
}

function scanNumbers(s: string): Nums {
  const toks = tokenize(s);
  const plain: string[] = [];
  const scaled: string[] = [];
  const raw = new Map<string, string>();
  const spell = (a: number, b: number) => toks.slice(a, b).map((x, k) => (k ? x.gap : "") + x.s).join("");
  const push = (a: string[], v: string, from: number, to: number) => {
    if (!a.includes(v)) a.push(v);
    if (!raw.has(v)) raw.set(v, spell(from, to));
  };
  const joined = (t?: Tok): t is Tok => !!t && !t.num && (t.gap === " " || t.gap === "-");
  const attached = (t?: Tok): t is Tok => !!t && !t.num && (t.gap === "" || t.gap === " " || t.gap === "-");
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    const next = toks[i + 1];
    let v: string | undefined;
    let j = i + 1;
    if (t.num) v = canonNumber(t.s);
    else if (t.code) push(plain, t.s, i, j);
    else if (UNIT_WORDS.includes(t.s)) v = String(UNIT_WORDS.indexOf(t.s));
    else if (ORDINAL_WORDS.includes(t.s)) v = String(ORDINAL_WORDS.indexOf(t.s));
    else if (ORDINAL_TENS.has(t.s)) v = String(ORDINAL_TENS.get(t.s));
    else if (TENS_WORDS.has(t.s)) {
      const u = joined(next) ? Math.max(UNIT_WORDS.indexOf(next.s), ORDINAL_WORDS.indexOf(next.s)) : -1;
      const unit = u >= 1 && u <= 9 ? u : 0;
      if (unit) j++;
      v = String(TENS_WORDS.get(t.s)! + unit);
    } else if (t.s === "dozen") v = "12";
    else if ((t.s === "a" || t.s === "an") && joined(next) && next.s !== "dozen" && SCALE_WORDS.includes(next.s)) {
      // "half a million" を "a million"（1 million）として通さない
      const prev = toks[i - 1];
      v = prev && t.gap === " " && (prev.s === "half" || prev.s === "quarter") ? prev.s : "1";
    } else if (AMOUNT_WORDS.includes(t.s)) push(plain, t.s, i, j);
    else if (CHANGE_WORDS.has(t.s)) push(plain, CHANGE_WORDS.get(t.s)!, i, j);
    else {
      const fold = foldOf(t.s);
      if (fold) push(plain, fold, i, j);
    }
    if (v === undefined) { i++; continue; }
    if (attached(toks[j]) && toks[j].s === "fold") { push(plain, `${v}fold`, i, j + 1); i = j + 1; continue; }
    if (!v.endsWith("%")) {
      if (joined(toks[j]) && toks[j].s === "percent") { v += "%"; j++; }
      else if (joined(toks[j]) && toks[j].s === "per" && toks[j + 1]?.s === "cent" && toks[j + 1].gap === " ") { v += "%"; j += 2; }
    }
    const k = j;
    const names: string[] = [];
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.num) break;
      if (SCALE_WORDS.includes(x.s) && (x.gap === "" || x.gap === " " || x.gap === "-")) names.push(x.s);
      else if (!names.length && SCALE_ABBR.has(x.s) && (x.gap === "" || (x.gap === " " && x.s.length > 1))) names.push(SCALE_ABBR.get(x.s)!);
      else break;
    }
    push(plain, v, i, names.length ? j : k);
    if (names.length) push(scaled, `${v} ${names.join(" ")}`, i, j);
    i = j;
  }
  return { plain, scaled, raw };
}

/**
 * 台本を出典の本文と照合する。errors が1件でもあればその本は出さない。
 * - 行数・語数・見出しの長さ（LIMITS）
 * - fact: source 必須・ホストが allowedHosts・docs に同じ URL の本文がある・quote が本文に語の区切りどおりに含まれる・
 *   say の数（型番・% を含む）がすべて quote にある
 * - framing: source を持たない・数は fact の行で確かめた数だけ
 * - hook: 数字（または around・about・nearly・almost・over・more than・at least・up to・some の後に数字）から始まり、
 *   数は fact の行で確かめた数だけ
 * - visual: counter/bars の値と見出しの数は確かめた数、map_zoom/route の地名はいずれかの fact の quote に出てくる
 * - quote_card は fact の行だけ。text はその行の quote の一部で、quote の中で引用符の内側にある言葉
 *   （本人の発言）か、who がその行の source.outlet と同じ（媒体の地の文を媒体の言葉として見せる）こと
 * - publishedAt が分かる fact の記事が maxLeadAgeHours より古ければ誤り（どの fact でも）
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
    else if (nq && !same.some(d => hasPhrase(normalizeText(d.text ?? ""), quote))) {
      fail(`引用文が出典の本文に無い「${quote.slice(0, 80)}」。本文の連続した部分を、語の途中で切らずにそのまま写す`);
    }

    const q = toSet(scanNumbers(quote));
    const s = scanNumbers(say);
    for (const n of missingIn(s, q)) errors.push(`${id}: ${what(n)} が引用文に無い（引用文の数: ${listOf(q)}）${wordHint(s, n)}`);
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
    if (!isFact) {
      const sayNums = scanNumbers(say);
      for (const n of missingIn(sayNums, ref)) errors.push(`${id}: ${what(n)} が${where}${wordHint(sayNums, n)}`);
    }

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
          errors.push(own.includes(n) ? `${id}: counter の値 ${n} が${where}` : `${id}: counter の見出し「${label}」の${what(n)} が${where}`);
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
          const own = numbersIn(String(it.value));
          if (!own.length) errors.push(`${id}: bars の値 ${it.value} を数として読めない`);
          // counter と同じく値と見出しを続けて読む（"40" と "% of Kyiv" で 40%）
          for (const n of unverified(`${it.value} ${label}`)) {
            errors.push(own.includes(n) ? `${id}: bars の値 ${n} が${where}` : `${id}: bars の見出し「${label}」の${what(n)} が${where}`);
          }
        }
        break;
      }
      case "quote_card": {
        if (!isFact) {
          errors.push(`${id}: framing の文に引用カードは置けない。発言は出典のある fact の文で見せ、framing は counter・bars・map_zoom・route にする`);
          break;
        }
        const text = typeof v.text === "string" ? v.text : "";
        const who = typeof v.who === "string" ? v.who : "";
        if (!who.trim()) errors.push(`${id}: 引用カードの who が空`);
        else for (const n of unverified(who)) errors.push(`${id}: 引用カードの who「${who}」の${what(n)} が${where}`);
        const w = wordCount(text);
        if (!w) errors.push(`${id}: 引用カードの text が空`);
        else if (w > LIMITS.maxQuoteCardWords) errors.push(`${id}: 引用カードの語数 ${w}（上限 ${LIMITS.maxQuoteCardWords}）`);
        if (!w) break;
        const outlet = typeof l.source?.outlet === "string" ? l.source.outlet : "";
        if (!hasPhrase(normalizeText(ownQuote), text)) errors.push(`${id}: 引用カードの文がこの行の引用文の一部でもない「${text.slice(0, 60)}」`);
        else if (normalizeText(text).includes('"')) errors.push(`${id}: 引用カードの text に引用符（"）を入れない。引用符の内側の言葉だけを写す`);
        else if (who.trim() && normalizeText(who) !== normalizeText(outlet) && !insideQuotes(ownQuote, text)) {
          // 記者の地の文・間接話法（According to him, …）を、本人の言葉として引用符つきで見せない
          errors.push(`${id}: 引用カードの文が引用文の中で引用符（"）の内側に無い（本人の言葉ではない）。`
            + `本人の発言なら引用符の内側の言葉だけを写す。記者の地の文・間接話法なら who を出典の媒体名「${outlet}」にするか、counter・map_zoom に替える`);
        }
        break;
      }
      default:
        errors.push(`${id}: visual の種類が不明（${String((v as { kind?: unknown }).kind)}）`);
    }
  });

  const hook = typeof sb?.hook === "string" ? sb.hook.trim() : "";
  if (!HOOK_START.test(hook)) errors.push(`hook: 数字から始まっていない「${hook}」（数字の前に置けるのは around・about・nearly・almost・over・more than・at least・up to・some だけ）`);
  const hookLen = [...hook].length;
  if (hookLen > LIMITS.maxHookChars) errors.push(`hook: ${hookLen} 字（上限 ${LIMITS.maxHookChars} 字）`);
  const hookNums = scanNumbers(hook);
  for (const n of missingIn(hookNums, verified)) errors.push(`hook: ${what(n)} が事実の文で確かめた数に無い（確かめた数: ${listOf(verified)}）${wordHint(hookNums, n)}`);

  for (const f of facts) {
    const published = f.source?.publishedAt;
    // Date.parse は "Sunday, Nov 1" を 2001 年と読むので ISO 形式のときだけ使う
    const pubMs = typeof published === "string" && /^\d{4}-\d{2}-\d{2}/.test(published.trim()) ? Date.parse(published.trim()) : NaN;
    if (!Number.isFinite(pubMs)) continue;
    const hours = (opts.now.getTime() - pubMs) / 3_600_000;
    if (hours > opts.maxLeadAgeHours) {
      errors.push(`${ids[lines.indexOf(f)]}: 事実の記事が ${Math.round(hours)} 時間前（上限 ${opts.maxLeadAgeHours} 時間）。${opts.maxLeadAgeHours} 時間以内の新しい記事の文に替えるか、この文を外す`);
    }
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

/** 誤りの文での呼び名。型番（"f-16"）は数ではないので分けて書く。 */
const what = (n: string) => (/^\p{L}+-?\d/u.test(n) ? `型番・名前 ${n}` : `数 ${n}`);

/** 数字で書いていない数（"one"・"third"・"a million" など）で落ちたときに、どの語を数と読んだかを直す側に示す。 */
const wordHint = (nums: Nums, n: string) => {
  const raw = nums.raw.get(n);
  return /^\d/.test(n) && raw && /^\p{L}/u.test(raw) ? `。語で書いた数「${raw}」を ${n} と読んだ（one・third・a million などの語も数として照らす）` : "";
};

const HOOK_START = /^(?:(?:around|about|nearly|almost|over|more than|at least|up to|some)\s+)?\d/i;

const hasAlnum = (s: string | undefined) => !!s && /[\p{L}\p{N}]/u.test(s);
const wordCount = (s: unknown) => (typeof s === "string" ? s.trim().split(/\s+/).filter(hasAlnum).length : 0);

/** hay（正規化済み）の中で needle が語の区切りどおりに出てくる位置。 */
function phraseAt(hay: string, needle: unknown): number[] {
  const n = typeof needle === "string" ? normalizeText(needle) : "";
  const at: number[] = [];
  if (!n) return at;
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) {
    const left = !hasAlnum(n[0]) || !hasAlnum(hay[i - 1]);
    const right = !hasAlnum(n[n.length - 1]) || !hasAlnum(hay[i + n.length]);
    if (left && right) at.push(i);
  }
  return at;
}

function hasPhrase(hay: string, needle: unknown): boolean {
  return phraseAt(hay, needle).length > 0;
}

/** 開きの引用符か。直前が文頭・空白・( [ : - で、直後が空白でない。 */
const opensAt = (s: string, i: number) => (i === 0 || /[\s(\[:-]/.test(s[i - 1])) && i + 1 < s.length && !/\s/.test(s[i + 1]);

/**
 * text が引用文の中で引用符（"）の内側にあるか。直前の引用符が開きなら内側。
 * 前に引用符が無く、後ろの最初の引用符が閉じなら、発言の途中から始まる引用文の内側。
 * 引用符の数の偶奇では見ない（発言の途中から始まる・途中で終わる引用文で、閉じの後ろや開きの前を内側に数えてしまう）。
 */
function insideQuotes(quote: string, text: string): boolean {
  const q = normalizeText(quote);
  const len = normalizeText(text).length;
  return phraseAt(q, text).some(i => {
    const before = i > 0 ? q.lastIndexOf('"', i - 1) : -1;
    if (before >= 0) return opensAt(q, before);
    const after = q.indexOf('"', i + len);
    return after >= 0 && !opensAt(q, after);
  });
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
