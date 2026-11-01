import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { DeskResult, DeskStory, NewsDeskPort } from "../../application/ports/NewsDeskPort.js";
import type { ExplainerStatus } from "../../domain/storyboard/ExplainerArm.js";
import {
  canonicalUrl, checkFacts, normalizeText,
  type FetchedDoc, type SourceRef, type Storyboard, type StoryLine, type Visual,
} from "../../domain/storyboard/Storyboard.js";
import type { CostMeter, Step } from "./CostMeter.js";
import { OUTLETS, isAllowedUrl, outletName } from "./outlets.js";

/**
 * 解説形式の台本を Claude API で作る（調べる → 書く → 照合 → 反証）。
 * 調べる: web_search で同じ出来事の報道を探し web_fetch で本文を取る（取得した本文が照合の正本）。
 * 書く: 構造化出力で台本を書かせ、checkFacts で数字と引用を本文と照合する。
 * 反証: 別の呼び出しに、引用と言い過ぎ・主語のすり替え・時制のずれが無いかを探させる。
 * 照合か反証で落ちたら1回だけ直させる。直しても落ちたら status で返し、呼ぶ側は今の形式で描く。
 * その本の呼び出しが1回でも返った後に止まったら（締め切り・予算切れ・API の誤りなど）incomplete。
 * 返る前なら api_error / cap（中身を見る前に決まるので、呼ぶ側は比較から外してよい）。
 * ただし段の時間切れと 400・422 は、調べる量や依頼の形がその本の中身で決まりうるので、最初の呼び出しでも incomplete。
 */

export const MODEL = "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];
const MAX_CONTINUATIONS = 4;
const DOC_CHARS_FOR_WRITER = 15_000;
const CONTEXT_CHARS = 300;
const MAX_LEAD_AGE_HOURS = 48;
// SDK の timeout は応答ヘッダーが届くまでしか効かず、流れ始めたストリームは止めない。段ごとの時間は signal で掛ける
const TIMEOUT_MS: Record<Step, number> = { research: 8 * 60_000, write: 4 * 60_000, refute: 4 * 60_000 };
const MAX_TOKENS: Record<Step, number> = { research: 32_000, write: 32_000, refute: 16_000 };

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type StreamParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "stream">;
type CallBody = Omit<StreamParams, "model" | "betas" | "fallbacks">;

/** Anthropic のクライアントのうち使う部分。試験では作り物を渡す。 */
export type DeskClient = {
  beta: { messages: { stream(body: StreamParams, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): { finalMessage(): Promise<BetaMessage> } } };
};

/** publishedAt: HTML の meta・JSON-LD・<time> にあった公開日時（ISO 8601）。 */
export type HttpPage = { title?: string; text: string; publishedAt?: string };

/** ページの日付。publishedAt はページ自身の公開日時、updatedAt は検索結果の page_age（最終更新）。 */
export type PageDates = { publishedAt?: string; updatedAt?: string };

export type NewsDeskOptions = {
  client: DeskClient;
  meter: CostMeter;
  now?: () => Date;
  /** web_fetch で Routine の出典を取れなかったときに、コードで取りに行く。 */
  httpGet?: (url: string) => Promise<HttpPage | null>;
  prompts?: Partial<Record<"research" | "writer" | "refute", string>>;
  /** 全体の締め切り。切れたら呼び出しを止める（その本の呼び出しが返った後なら incomplete、前なら api_error）。 */
  signal?: AbortSignal;
  /** 段ごとの1回の呼び出しの時間（ミリ秒）。切れたら最初の呼び出しでも incomplete。試験で短くする。 */
  stepTimeoutMs?: Partial<Record<Step, number>>;
};

const RESEARCH_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  // 動的フィルタ（コード実行からの検索）だと検索結果が web_fetch の取得元として数えられる保証が無いので direct にする
  { type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: [...OUTLETS], allowed_callers: ["direct"] },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6, allowed_domains: [...OUTLETS], max_content_tokens: 12_000 },
];

const STR = { type: "string" } as const;
const nullable = (s: object) => ({ anyOf: [s, { type: "null" }] });

/** 構造化出力の制約（additionalProperties: false・全項目 required・min/max の数値制約なし）に合わせた平らな形。 */
export const STORYBOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "whyPicked", "lines"],
  properties: {
    hook: { type: "string", description: "On-screen headline, at most 40 characters, starts with the key number (only its qualifier, then a currency sign such as $, may come before the digits)." },
    whyPicked: { type: "string" },
    lines: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "say", "source", "visual"],
        properties: {
          id: STR,
          kind: { type: "string", enum: ["fact", "framing"] },
          say: STR,
          // 媒体名は URL からコードが入れる（outletName）ので書かせない
          source: nullable({
            type: "object",
            additionalProperties: false,
            required: ["url", "quote"],
            properties: { url: STR, quote: STR },
          }),
          visual: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "places", "value", "label", "items", "from", "to", "who", "text"],
            properties: {
              kind: { type: "string", enum: ["map_zoom", "counter", "bars", "route", "quote_card"] },
              places: nullable({ type: "array", items: STR }),
              value: nullable({ type: "number" }),
              label: nullable(STR),
              items: nullable({
                type: "array",
                items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: STR, value: { type: "number" } } },
              }),
              from: nullable(STR),
              to: nullable(STR),
              who: nullable(STR),
              text: nullable(STR),
            },
          },
        },
      },
    },
  },
} as const;

export const REFUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "problems"],
  properties: {
    pass: { type: "boolean" },
    problems: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["lineId", "problem"], properties: { lineId: STR, problem: STR } },
    },
  },
} as const;

class Stop extends Error {
  constructor(readonly status: ExplainerStatus, message: string) {
    super(message);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.resolve(HERE, "..", "..", "prompts", "news");
const readPrompt = (name: string) => fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf-8");

export class NewsDesk implements NewsDeskPort {
  private readonly client: DeskClient;
  private readonly meter: CostMeter;
  private readonly now: () => Date;
  private readonly httpGet: (url: string) => Promise<HttpPage | null>;
  private readonly prompts: Record<"research" | "writer" | "refute", string>;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: Record<Step, number>;

  constructor(opts: NewsDeskOptions) {
    this.client = opts.client;
    this.meter = opts.meter;
    this.now = opts.now ?? (() => new Date());
    this.httpGet = opts.httpGet ?? fetchPageText;
    this.signal = opts.signal;
    this.timeoutMs = { ...TIMEOUT_MS, ...opts.stepTimeoutMs };
    this.prompts = {
      research: opts.prompts?.research ?? readPrompt("research"),
      writer: opts.prompts?.writer ?? readPrompt("writer"),
      refute: opts.prompts?.refute ?? readPrompt("refute"),
    };
  }

  async write(story: DeskStory): Promise<DeskResult> {
    let docs: FetchedDoc[] = [];
    const result = (status: ExplainerStatus, errors: string[], storyboard?: Storyboard): DeskResult =>
      ({ status, ...(storyboard ? { storyboard } : {}), docs, errors, costUsd: this.meter.storyCost(story.index) });
    try {
      const research = await this.research(story);
      docs = research.docs;
      if (!docs.length) return result("no_docs", ["許可した媒体のページを1つも取得できなかった"]);

      let repairUsed = false;
      let draft = await this.draft(story, research.notes, docs, research.dates);
      if (draft.errors.length) {
        repairUsed = true;
        draft = await this.repair(story, draft, docs, research.dates, draft.errors);
        if (draft.errors.length) return result("check_failed", draft.errors);
      }
      let problems = await this.refute(story, draft.sb!, docs, research.dates);
      if (problems.length) {
        if (repairUsed) return result("refuted", problems);
        draft = await this.repair(story, draft, docs, research.dates, problems);
        if (draft.errors.length) return result("check_failed", draft.errors);
        problems = await this.refute(story, draft.sb!, docs, research.dates);
        if (problems.length) return result("refuted", problems);
      }
      return result("ok", [], draft.sb);
    } catch (e) {
      if (e instanceof Stop) {
        const started = (e.status === "api_error" || e.status === "cap") && this.meter.completedCalls(story.index) > 0;
        return result(started ? "incomplete" : e.status, [e.message]);
      }
      throw e;
    }
  }

  private async call(story: DeskStory, step: Step, body: CallBody): Promise<BetaMessage> {
    if (this.signal?.aborted) throw new Stop("api_error", `${step}: 全体の締め切りを過ぎたので呼ばない`);
    const hold = this.meter.reserve(step, story.index);
    if (!hold) {
      const budget = this.meter.storyBudget(story.index);
      throw new Stop("cap", budget === undefined
        ? `${step}: 1回の実行の上限 $${this.meter.capUsd} に届くので呼ばない（使った額 $${this.meter.spent.toFixed(3)}）`
        : `${step}: この本の予算 $${budget} に届くので呼ばない（この本で使った額 $${this.meter.storyCost(story.index).toFixed(3)}）`);
    }
    const stepTimer = AbortSignal.timeout(this.timeoutMs[step]);
    const signal = this.signal ? AbortSignal.any([this.signal, stepTimer]) : stepTimer;
    let msg: BetaMessage;
    try {
      msg = await this.client.beta.messages
        .stream({ model: MODEL, betas: BETAS, fallbacks: "default", ...body }, { timeout: this.timeoutMs[step], maxRetries: 1, signal })
        .finalMessage();
    } catch (e) {
      this.meter.recordEstimate(hold, MODEL);
      if (e instanceof Anthropic.AnthropicError) {
        const status = e instanceof Anthropic.APIError && e.status ? ` ${e.status}` : "";
        const stepTimedOut = stepTimer.aborted && !this.signal?.aborted;
        const why = this.signal?.aborted ? "全体の締め切りで止めた: " : stepTimedOut ? `1回の時間 ${this.timeoutMs[step] / 1000} 秒を過ぎた: ` : "";
        // 最初の呼び出しの 400/422 は依頼の形（媒体の一覧など設定）の誤りでほぼ全本に起きるので、腕に数えず api_error で外す
        throw new Stop(stepTimedOut ? "incomplete" : "api_error", `${step}: ${why}${e.name}${status}: ${e.message}`);
      }
      throw e;
    }
    this.meter.record(hold, msg.model, msg.usage);
    if (msg.stop_reason === "refusal") {
      throw new Stop("refusal", `${step}: 拒否された（${msg.stop_details?.category ?? "分類なし"}）`);
    }
    if (msg.stop_reason === "max_tokens") throw new Stop("incomplete", `${step}: max_tokens (${body.max_tokens}) で出力が切れた`);
    return msg;
  }

  private async research(story: DeskStory) {
    const user: BetaMessageParam = { role: "user", content: researchRequest(story) };
    const done: BetaContentBlock[] = [];
    for (let turn = 0; ; turn++) {
      const messages: BetaMessageParam[] = done.length ? [user, { role: "assistant", content: [...done] }] : [user];
      const msg = await this.call(story, "research", {
        max_tokens: MAX_TOKENS.research,
        system: this.prompts.research,
        messages,
        tools: RESEARCH_TOOLS,
        output_config: { effort: "medium" },
      });
      done.push(...msg.content);
      if (msg.stop_reason !== "pause_turn") break;
      if (turn >= MAX_CONTINUATIONS) throw new Stop("incomplete", `research: pause_turn が ${MAX_CONTINUATIONS} 回続けても終わらない`);
    }

    const docs = extractDocs(done).filter(d => isAllowedUrl(d.url));
    const dates = new Map<string, PageDates>();
    for (const [key, updatedAt] of extractPageAges(done, this.now())) dates.set(key, { updatedAt });
    const src = story.sourceUrl?.trim();
    if (src && isAllowedUrl(src) && !docs.some(d => canonicalUrl(d.url) === canonicalUrl(src))) {
      const page = await this.httpGet(src);
      const text = page ? stripRelatedLinks(page.text) : "";
      if (page && text.trim().length >= 200) {
        docs.push({ url: src, ...(page.title ? { title: page.title } : {}), text, retrievedAt: this.now().toISOString(), via: "http" });
        if (page.publishedAt) dates.set(canonicalUrl(src), { ...dates.get(canonicalUrl(src)), publishedAt: page.publishedAt });
      }
    }
    const notes = done.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map(b => b.text).join("\n").trim();
    return { docs, notes, dates };
  }

  private writeRequest(story: DeskStory, notes: string, docs: FetchedDoc[]): BetaMessageParam {
    const pages = docs.map((d, i) => {
      const attrs = `id="${i + 1}" url="${d.url}" outlet="${outletName(d.url)}"${d.title ? ` title="${d.title.replace(/"/g, "'")}"` : ""}`;
      return `<page ${attrs}>\n${d.text.slice(0, DOC_CHARS_FOR_WRITER)}\n</page>`;
    }).join("\n\n");
    return {
      role: "user",
      content: [
        // 直しの呼び出しでも同じ前半（指示とページ本文）を読み直すのでキャッシュに置く
        { type: "text", text: `Fetched pages. Copy quotes only from these texts.\n\n${pages}`, cache_control: { type: "ephemeral" } },
        { type: "text", text: `${storyText(story)}\n\nResearch notes:\n${notes || "(none)"}\n\nWrite the storyboard.` },
      ],
    };
  }

  private async draft(story: DeskStory, notes: string, docs: FetchedDoc[], dates: Map<string, PageDates>): Promise<Draft> {
    const messages = [this.writeRequest(story, notes, docs)];
    return this.runWriter(story, messages, docs, dates);
  }

  private async repair(story: DeskStory, prev: Draft, docs: FetchedDoc[], dates: Map<string, PageDates>, problems: string[]): Promise<Draft> {
    const fix: BetaMessageParam = {
      role: "user",
      content: "Our checks found these problems (some are written in Japanese). Fix exactly these. Do not add new facts; " +
        "drop or rewrite a sentence when its quote cannot support it. Return the whole corrected storyboard.\n" +
        problems.map(p => `- ${p}`).join("\n"),
    };
    // 前の答えは thinking ごとそのまま返す（履歴を書き換えない）
    const messages: BetaMessageParam[] = [...prev.messages, { role: "assistant", content: prev.content }, fix];
    return this.runWriter(story, messages, docs, dates);
  }

  private async runWriter(story: DeskStory, messages: BetaMessageParam[], docs: FetchedDoc[], dates: Map<string, PageDates>): Promise<Draft> {
    const msg = await this.call(story, "write", {
      max_tokens: MAX_TOKENS.write,
      system: this.prompts.writer,
      messages,
      output_config: { effort: "medium", format: { type: "json_schema", schema: STORYBOARD_SCHEMA } },
    });
    const base = { messages, content: msg.content };
    let raw: unknown;
    try {
      raw = JSON.parse(textOf(msg.content));
    } catch (e) {
      return { ...base, errors: [`全体: 台本の JSON を読めない（${e instanceof Error ? e.message : e}）`] };
    }
    const { sb, errors } = toStoryboard(raw, story, dates);
    if (!sb) return { ...base, errors };
    const check = checkFacts(sb, docs, { now: this.now(), allowedHosts: [...OUTLETS], maxLeadAgeHours: MAX_LEAD_AGE_HOURS });
    return { ...base, sb, errors: check.errors };
  }

  private async refute(story: DeskStory, sb: Storyboard, docs: FetchedDoc[], dates: Map<string, PageDates>): Promise<string[]> {
    const msg = await this.call(story, "refute", {
      max_tokens: MAX_TOKENS.refute,
      system: this.prompts.refute,
      messages: [{ role: "user", content: refuteRequest(sb, docs, dates) }],
      output_config: { effort: "high", format: { type: "json_schema", schema: REFUTE_SCHEMA } },
    });
    let verdict: { pass?: unknown; problems?: unknown };
    try {
      verdict = JSON.parse(textOf(msg.content));
    } catch (e) {
      throw new Stop("incomplete", `refute: 答えの JSON を読めない（${e instanceof Error ? e.message : e}）`);
    }
    const problems = (Array.isArray(verdict.problems) ? verdict.problems : [])
      .map((p: { lineId?: unknown; problem?: unknown }) => `${String(p?.lineId ?? "?")}: ${String(p?.problem ?? "").trim()}`);
    if (verdict.pass !== true && !problems.length) problems.push("全体: 反証が不合格としたが理由が無い");
    return problems;
  }
}

type Draft = { messages: BetaMessageParam[]; content: BetaContentBlockParam[]; sb?: Storyboard; errors: string[] };

const textOf = (content: readonly BetaContentBlock[]) =>
  content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map(b => b.text).join("");

function storyText(story: DeskStory): string {
  const lines = [
    `Date: ${story.date}`,
    `Country: ${story.countryName ? `${story.countryName} (${story.countryCode})` : story.countryCode}`,
    `Headline: ${story.headline}`,
    `Editor's summary: ${story.summary}`,
  ];
  const src = story.sourceUrl?.trim();
  if (src && isAllowedUrl(src)) lines.push(`Editor's source: ${story.sourceName} - ${src}`);
  else lines.push(`Editor's source: ${story.sourceName} (not on the allowed list; find other reports)`);
  if (story.places?.length) lines.push(`Places named by the editor: ${story.places.join(", ")}`);
  return lines.join("\n");
}

/** web_fetch は会話に出た URL しか取れないので、出典の URL はユーザーのメッセージに入れる。 */
function researchRequest(story: DeskStory): string {
  return `Story picked by our editor:\n${storyText(story)}\n\nResearch this event.`;
}

function refuteRequest(sb: Storyboard, docs: FetchedDoc[], dates: Map<string, PageDates>): string {
  const parts = [`Script date: ${sb.date}`, `Hook: ${JSON.stringify(sb.hook)}`, "", "Lines:"];
  for (const l of sb.lines) {
    parts.push(`[${l.id}] ${l.kind}`, `  say: ${JSON.stringify(l.say)}`, `  visual: ${JSON.stringify(l.visual)}`);
    if (l.kind === "fact" && l.source) {
      const d = dates.get(canonicalUrl(l.source.url));
      parts.push(
        `  outlet: ${l.source.outlet} (${l.source.url})`,
        `  page published: ${d?.publishedAt ?? "unknown"}`,
        `  page last updated (search result): ${d?.updatedAt ?? "unknown"}`,
        `  quote: ${JSON.stringify(l.source.quote)}`,
        `  page text around the quote: ${JSON.stringify(contextOf(l.source, docs))}`,
      );
    }
  }
  return parts.join("\n");
}

/** 引用の前後 300 字。原文で見つからなければ（引用符などの揺れ）正規化した本文から取る。 */
function contextOf(src: SourceRef, docs: FetchedDoc[]): string {
  const doc = docs.find(d => canonicalUrl(d.url) === canonicalUrl(src.url));
  if (!doc) return "";
  const around = (text: string, q: string) => {
    const i = text.indexOf(q);
    return i < 0 ? null : text.slice(Math.max(0, i - CONTEXT_CHARS), i + q.length + CONTEXT_CHARS);
  };
  return around(doc.text, src.quote) ?? around(normalizeText(doc.text), normalizeText(src.quote)) ?? "";
}

// 本文に差し込まれた別記事へのリンクの行（Ukrinform の「Read also: <見出し>」など）。web_fetch の Markdown の飾りも許す
const RELATED_LINK = /^[\s>*_#|•·\-–—[]*(?:read (?:also|more)|also read|see also|related(?: articles?| stories| news| coverage| content| reading)?|most (?:read|popular|viewed)|recommended(?: for you| stories| reading)?|more (?:on this|stories|from [^:]{1,40})|more(?=[\s*_\]]*$)|you (?:may|might) also like|trending(?: now)?|what['’]?s trending|editor(?:s['’]?|['’]s) picks)(?:[\s*_]*\]\(|[\s*_\]]*(?:[:：|»›]|$))/i;

// Al Jazeera の読み上げ用の印（list of 3 items・list 1 of 3 <見出し>・end of list）
const LIST_MARK = /^[\s>*_#|•·\-–—[]*(?:list (?:of )?\d+(?: of \d+| items)\b|end of list[\s*_\]]*$)/i;
// 1行まるごと Markdown のリンク1本（web_fetch の本文の関連記事の並び）
const LINK_LINE = /^[\s>*_#|•·\-–—]*(?:\d+[.)]\s+)?\[[^\]]+\]\([^)\s]+\)[\s*_]*$/;

const SENTENCE_END = /[.!?…"”]$/;

/**
 * 関連記事のリンクの行を落とす。その見出しは別の記事（別の日のこともある）なので、引用の元にさせない。
 * 「Related」だけの行のように見出しが次の行に来るときは、続く見出しらしい行（文の終わりの記号が無い行）も落とす。
 * 並びの印（list 1 of 3）の行と、1行まるごとリンク1本の行は、文の終わりの記号があっても落とす。
 */
export function stripRelatedLinks(text: string): string {
  const out: string[] = [];
  let inList = false;
  for (const line of text.split("\n")) {
    const m = RELATED_LINK.exec(line);
    if (m) {
      inList = !line.slice(m[0].length).replace(/[\s*_\]:：|»›]/g, "");
      continue;
    }
    if (LIST_MARK.test(line) || LINK_LINE.test(line)) continue;
    const t = line.trim();
    if (inList && t && t.length <= 200 && !SENTENCE_END.test(t)) continue;
    if (t) inList = false;
    out.push(line);
  }
  return out.join("\n");
}

/** web_fetch の結果から本文（text）を集める。取得の失敗と PDF（base64）は使わない。同じ URL は長い方を残す。 */
export function extractDocs(blocks: readonly BetaContentBlock[]): FetchedDoc[] {
  const byUrl = new Map<string, FetchedDoc>();
  for (const b of blocks) {
    if (b.type !== "web_fetch_tool_result" || b.content.type !== "web_fetch_result") continue;
    const r = b.content;
    const source = r.content?.source;
    if (source?.type !== "text" || typeof source.data !== "string") continue;
    const text = stripRelatedLinks(source.data);
    if (!text.trim()) continue;
    const doc: FetchedDoc = {
      url: r.url,
      ...(r.content.title ? { title: r.content.title } : {}),
      text,
      ...(r.retrieved_at ? { retrievedAt: r.retrieved_at } : {}),
      via: "web_fetch",
    };
    const key = canonicalUrl(r.url);
    const prev = byUrl.get(key);
    if (!prev || prev.text.length < doc.text.length) byUrl.set(key, doc);
  }
  return [...byUrl.values()];
}

/**
 * 検索結果の page_age（canonicalUrl → ISO 8601）。ドキュメントの定義は「最終更新」で公開日ではない。
 * 公開日は最終更新より前なので、古ければ確実に古いという片側の判定にだけ使える。
 * "April 30, 2025" のように年のあるものと、"3 hours ago" のような相対の書き方（now から引く）を読む。
 */
export function extractPageAges(blocks: readonly BetaContentBlock[], now: Date): Map<string, string> {
  const ages = new Map<string, string>();
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      const iso = toIso(r.page_age, now);
      if (iso && !ages.has(canonicalUrl(r.url))) ages.set(canonicalUrl(r.url), iso);
    }
  }
  return ages;
}

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };

function toIso(s: string | null | undefined, now?: Date): string | null {
  const t = String(s ?? "").trim();
  const rel = /^(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(t);
  if (rel && now) return new Date(now.getTime() - (/^\d/.test(rel[1]) ? Number(rel[1]) : 1) * UNIT_MS[rel[2].toLowerCase()]).toISOString();
  if (!/\b(19|20)\d{2}\b/.test(t)) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type RawVisual = {
  kind?: unknown; places?: unknown; value?: unknown; label?: unknown; items?: unknown;
  from?: unknown; to?: unknown; who?: unknown; text?: unknown;
};

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toVisual(v: RawVisual | null | undefined, id: string, errors: string[]): Visual | null {
  const kind = v?.kind;
  const missing = (field: string) => { errors.push(`${id}: visual ${String(kind)} の ${field} が無いか形が違う`); return null; };
  switch (kind) {
    case "map_zoom":
      return Array.isArray(v!.places) && v!.places.length && v!.places.every(isStr) ? { kind, places: v!.places } : missing("places");
    case "counter":
      if (!isNum(v!.value)) return missing("value");
      return isStr(v!.label) ? { kind, value: v!.value, label: v!.label } : missing("label");
    case "bars": {
      const items = v!.items;
      const ok = Array.isArray(items) && items.length > 0 &&
        items.every((it: { label?: unknown; value?: unknown } | null) => isStr(it?.label) && isNum(it?.value));
      return ok ? { kind, items: (items as Array<{ label: string; value: number }>).map(it => ({ label: it.label, value: it.value })) } : missing("items");
    }
    case "route":
      if (!isStr(v!.from)) return missing("from");
      return isStr(v!.to) ? { kind, from: v!.from, to: v!.to } : missing("to");
    case "quote_card":
      if (!isStr(v!.who)) return missing("who");
      return isStr(v!.text) ? { kind, who: v!.who, text: v!.text } : missing("text");
    default:
      errors.push(`${id}: visual の kind が不明（${String(kind)}）`);
      return null;
  }
}

/**
 * 構造化出力の平らな JSON を台本の型に直す。version・date・storyIndex・countryCode と出典の媒体名・日付はコードが入れる。
 * 出典の publishedAt は、ページ自身の公開日時が無ければ page_age（最終更新）を入れる（最終更新が古ければ記事も古いので、落とす側には正しく効く）。
 * 形の誤りがあれば sb は返さない（直しの呼び出しに errors を渡す）。
 */
export function toStoryboard(raw: unknown, story: DeskStory, dates: Map<string, PageDates>): { sb?: Storyboard; errors: string[] } {
  const r = raw as { hook?: unknown; whyPicked?: unknown; lines?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.lines)) return { errors: ["全体: 台本の JSON の形が違う（lines が無い）"] };
  const errors: string[] = [];
  const lines: StoryLine[] = [];
  r.lines.forEach((l: { id?: unknown; kind?: unknown; say?: unknown; source?: unknown; visual?: unknown } | null, i: number) => {
    const id = isStr(l?.id) ? l.id.trim() : `#${i + 1}`;
    if (l?.kind !== "fact" && l?.kind !== "framing") { errors.push(`${id}: kind が fact でも framing でもない`); return; }
    const visual = toVisual(l.visual as RawVisual | null, id, errors);
    if (!visual) return;
    const line: StoryLine = { id, kind: l.kind, say: typeof l.say === "string" ? l.say.trim() : "", visual };
    const s = l.source as { url?: unknown; quote?: unknown } | null | undefined;
    if (s && typeof s === "object") {
      const url = typeof s.url === "string" ? s.url.trim() : "";
      const d = dates.get(canonicalUrl(url));
      const publishedAt = d?.publishedAt ?? d?.updatedAt;
      line.source = {
        outlet: outletName(url),
        url,
        quote: typeof s.quote === "string" ? s.quote : "",
        ...(publishedAt ? { publishedAt } : {}),
      };
    }
    lines.push(line);
  });
  if (errors.length) return { errors };
  return {
    sb: {
      version: 1,
      date: story.date,
      storyIndex: story.index,
      countryCode: story.countryCode,
      hook: typeof r.hook === "string" ? r.hook.trim() : "",
      lines,
      whyPicked: typeof r.whyPicked === "string" ? r.whyPicked.trim() : "",
    },
    errors,
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);

// <article> を選ぶ前に落とす（CBS は関連記事の aside の中に <article> があり、本文の <article> がそこで切れていた）
const dropNoise = (html: string) => html
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(script|style|noscript|svg|template|iframe|aside|nav)\b[\s\S]*?<\/\1>/gi, " ");

// ブロックを包むリンク（CBC の関連記事のカード）と、リンク1本だけの li・div（Al Jazeera・Japan Times の見出しの並び）は別記事なので本文にしない。
// タグを空白に替えると発言の開きの引用符の後ろに空白ができ、閉じと読まれるので詰める
const textOfHtml = (html: string) => decode(html
  .replace(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<(?:p|div|h[1-6])\b[\s\S]*?<\/a>/gi, " ")
  .replace(/<li\b[^>]*>\s*(?:<span\b[^>]*>[^<]*<\/span>\s*)*<a\b[^>]*>[^<]*<\/a>\s*<\/li>/gi, " ")
  .replace(/<div\b[^>]*>\s*<a\b[^>]*>[^<]*<\/a>\s*<\/div>/gi, " ")
  .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|section|article|header|footer|figure|figcaption|blockquote)\b[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .split("\n").map(s => s.replace(/[ \t ]+/g, " ").trim().replace(/“ /g, "“").replace(/ ”/g, "”")).filter(Boolean).join("\n");

const PUBLISHED_META = ["article:published_time", "og:article:published_time", "datepublished", "pubdate", "publishdate"];

function metaContent(html: string, names: readonly string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && content && names.includes(key)) return content;
  }
  return undefined;
}

/**
 * HTML を本文の文字列にする。<article> があれば、文字にして一番長いもの（200字以上）だけを使う
 * （先頭の <article> は「最新の記事」の札のことがある）。aside・nav と、関連記事のカード・リンク1本だけの li・div は落とす。
 * 公開日時は meta article:published_time → JSON-LD datePublished → 選んだ <article> の <time datetime> の順に読む。
 */
export function htmlToText(html: string): HttpPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = dropNoise(html);
  const best = [...body.matchAll(/<article[\s>][\s\S]*?<\/article>/gi)]
    .map(m => ({ html: m[0], text: textOfHtml(m[0]) }))
    .reduce<{ html: string; text: string } | undefined>((a, c) => (!a || c.text.length > a.text.length ? c : a), undefined);
  const article = best && best.text.length >= 200 ? best : undefined;
  const text = article ? article.text : textOfHtml(body);
  const published = [
    metaContent(html, PUBLISHED_META),
    /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1],
    article ? /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(article.html)?.[1] : undefined,
  ].map(s => toIso(s)).find((s): s is string => !!s);
  return { ...(title ? { title: decode(title).replace(/\s+/g, " ").trim() } : {}), text, ...(published ? { publishedAt: published } : {}) };
}

const HTTP_UA = "DailyWorld60-factcheck/1.0";
const ROBOTS_AGENT = "claude-user";
const MAX_REDIRECTS = 5;

/**
 * robots.txt でこの URL を取ってよいか。Claude-User の節（無ければ *）の規則を使う（RFC 9309: 最も長く一致した規則、同じ長さなら Allow）。
 * 自前の HTTP は Claude に渡す本文を取るためなので、Claude-User を断っている媒体は取らない。
 */
export function robotsAllows(robotsTxt: string, url: string, agent = ROBOTS_AGENT): boolean {
  type Rule = { allow: boolean; path: string };
  type Group = { agents: string[]; rules: Rule[] };
  const groups: Group[] = [];
  let cur: Group | undefined;
  let inAgents = false;
  for (const raw of robotsTxt.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ""));
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!cur || !inAgents) groups.push(cur = { agents: [], rules: [] });
      cur.agents.push(m[2].toLowerCase());
      inAgents = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      cur.rules.push({ allow: key === "allow", path: m[2] });
      inAgents = false;
    }
  }
  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return false;
  }
  const a = agent.toLowerCase();
  const mine = groups.filter(g => g.agents.includes(a));
  let best: Rule | undefined;
  for (const r of (mine.length ? mine : groups.filter(g => g.agents.includes("*"))).flatMap(g => g.rules)) {
    if (!r.path || !robotsPattern(r.path).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

function robotsPattern(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

async function robotsAllowUrl(url: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(new URL("/robots.txt", url).toString(), { signal: AbortSignal.timeout(10_000), redirect: "follow", headers: { "user-agent": HTTP_UA } });
    // 読めない robots.txt は断られているものとみなす
    if (!res.ok) return false;
    return robotsAllows(await res.text(), url);
  } catch {
    return false;
  }
}

/** Routine の出典を自前で取る。許可した媒体で、robots.txt が Claude-User に許しているページだけ。転送先も1つずつ確かめる。 */
export async function fetchPageText(url: string, fetchFn: typeof fetch = fetch): Promise<HttpPage | null> {
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(target) || !(await robotsAllowUrl(target, fetchFn))) return null;
      const res = await fetchFn(target, {
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
        headers: { "user-agent": HTTP_UA, accept: "text/html,application/xhtml+xml,text/plain" },
      });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (loc) {
        target = new URL(loc, target).toString();
        continue;
      }
      if (!res.ok) return null;
      if (!/html|text\/plain/i.test(res.headers.get("content-type") ?? "")) return null;
      return htmlToText(await res.text());
    }
    return null;
  } catch {
    return null;
  }
}
