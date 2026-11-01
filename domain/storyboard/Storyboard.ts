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
 */
export function normalizeText(s: string): string {
  throw new Error("not implemented");
}

/**
 * 文に出てくる数を正規化した文字列で返す（重複は除く）。
 * "1,200"→"1200"、"3.50"→"3.5"、"40%"→"40"、"one"〜"twenty"・"dozen"→数字。
 * "1.2 million" は "1.2"（単位は照合しない）。年（2026）も数として扱う。
 */
export function numbersIn(s: string): string[] {
  throw new Error("not implemented");
}

/** 比較用の URL。スキーム・www・クエリ・#・末尾の / を落とし小文字にする。 */
export function canonicalUrl(url: string): string {
  throw new Error("not implemented");
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
 */
export function checkFacts(sb: Storyboard, docs: FetchedDoc[], opts: CheckOptions): CheckResult {
  throw new Error("not implemented");
}

export type Word = { w: string; t: number; d: number };
export type Beat = { lineId: string; start: number; end: number; from: number; to: number };

/**
 * 読み上げの単語の時刻を台本の文に割り当てる。words は lines の say を順に読んだもの。
 * 文ごとに正規化した文字数を積み上げて境界を決める（prep-short の sentenceBounds と同じ考え方）。
 * from/to は words のインデックス（to は含まない）。start は最初の語の t、end は最後の語の t+d。
 */
export function alignBeats(lines: StoryLine[], words: Word[]): Beat[] {
  throw new Error("not implemented");
}
