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
import { OUTLETS, hostOf, isAllowedUrl } from "./outlets.js";

/**
 * 解説形式の台本を Claude API で作る（調べる → 書く → 照合 → 反証）。
 * 調べる: web_search で同じ出来事の報道を探し web_fetch で本文を取る（取得した本文が照合の正本）。
 * 書く: 構造化出力で台本を書かせ、checkFacts で数字と引用を本文と照合する。
 * 反証: 別の呼び出しに、引用と言い過ぎ・主語のすり替え・時制のずれが無いかを探させる。
 * 照合か反証で落ちたら1回だけ直させる。直しても落ちたら status で返し、呼ぶ側は今の形式で描く。
 */

export const MODEL = "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];
const MAX_CONTINUATIONS = 4;
const DOC_CHARS_FOR_WRITER = 15_000;
const CONTEXT_CHARS = 300;
const MAX_LEAD_AGE_HOURS = 48;
// SDK は時間切れも1回だけ試し直す（maxRetries 1）。全体の締め切りは write-explainers が signal で掛ける
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

export type HttpPage = { title?: string; text: string };

export type NewsDeskOptions = {
  client: DeskClient;
  meter: CostMeter;
  now?: () => Date;
  /** web_fetch で Routine の出典を取れなかったときに、コードで取りに行く。 */
  httpGet?: (url: string) => Promise<HttpPage | null>;
  prompts?: Partial<Record<"research" | "writer" | "refute", string>>;
  /** 全体の締め切り。切れたら呼び出しを止め、その本は api_error（比較から外す）。 */
  signal?: AbortSignal;
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
    hook: { type: "string", description: "On-screen headline, at most 40 characters, starts with the key number." },
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
          source: nullable({
            type: "object",
            additionalProperties: false,
            required: ["outlet", "url", "quote"],
            properties: { outlet: STR, url: STR, quote: STR },
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

  constructor(opts: NewsDeskOptions) {
    this.client = opts.client;
    this.meter = opts.meter;
    this.now = opts.now ?? (() => new Date());
    this.httpGet = opts.httpGet ?? fetchPageText;
    this.signal = opts.signal;
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
      let draft = await this.draft(story, research.notes, docs, research.hints);
      if (draft.errors.length) {
        repairUsed = true;
        draft = await this.repair(story, draft, docs, research.hints, draft.errors);
        if (draft.errors.length) return result("check_failed", draft.errors);
      }
      let problems = await this.refute(story, draft.sb!, docs);
      if (problems.length) {
        if (repairUsed) return result("refuted", problems);
        draft = await this.repair(story, draft, docs, research.hints, problems);
        if (draft.errors.length) return result("check_failed", draft.errors);
        problems = await this.refute(story, draft.sb!, docs);
        if (problems.length) return result("refuted", problems);
      }
      return result("ok", [], draft.sb);
    } catch (e) {
      if (e instanceof Stop) return result(e.status, [e.message]);
      throw e;
    }
  }

  private async call(story: DeskStory, step: Step, body: CallBody): Promise<BetaMessage> {
    if (this.signal?.aborted) throw new Stop("api_error", `${step}: 全体の締め切りを過ぎたので呼ばない`);
    const hold = this.meter.reserve(step);
    if (!hold) throw new Stop("cap", `${step}: 1日の上限 $${this.meter.capUsd} に届くので呼ばない（使った額 $${this.meter.spent.toFixed(3)}）`);
    let msg: BetaMessage;
    try {
      msg = await this.client.beta.messages
        .stream({ model: MODEL, betas: BETAS, fallbacks: "default", ...body }, { timeout: TIMEOUT_MS[step], maxRetries: 1, ...(this.signal ? { signal: this.signal } : {}) })
        .finalMessage();
    } catch (e) {
      this.meter.release(hold);
      if (e instanceof Anthropic.AnthropicError) {
        const status = e instanceof Anthropic.APIError && e.status ? ` ${e.status}` : "";
        throw new Stop("api_error", `${step}: ${e.name}${status}: ${e.message}`);
      }
      throw e;
    }
    this.meter.record(hold, story.index, msg.model, msg.usage);
    if (msg.stop_reason === "refusal") {
      throw new Stop("refusal", `${step}: 拒否された（${msg.stop_details?.category ?? "分類なし"}）`);
    }
    if (msg.stop_reason === "max_tokens") throw new Stop("api_error", `${step}: max_tokens (${body.max_tokens}) で出力が切れた`);
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
      if (turn >= MAX_CONTINUATIONS) throw new Stop("api_error", `research: pause_turn が ${MAX_CONTINUATIONS} 回続けても終わらない`);
    }

    const docs = extractDocs(done).filter(d => isAllowedUrl(d.url));
    const src = story.sourceUrl?.trim();
    if (src && isAllowedUrl(src) && !docs.some(d => canonicalUrl(d.url) === canonicalUrl(src))) {
      const page = await this.httpGet(src);
      if (page && page.text.trim().length >= 200) {
        docs.push({ url: src, ...(page.title ? { title: page.title } : {}), text: page.text, retrievedAt: this.now().toISOString(), via: "http" });
      }
    }
    const notes = done.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map(b => b.text).join("\n").trim();
    return { docs, notes, hints: extractPublishedHints(done) };
  }

  private writeRequest(story: DeskStory, notes: string, docs: FetchedDoc[]): BetaMessageParam {
    const pages = docs.map((d, i) => {
      const attrs = `id="${i + 1}" url="${d.url}" outlet="${hostOf(d.url) ?? ""}"${d.title ? ` title="${d.title.replace(/"/g, "'")}"` : ""}`;
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

  private async draft(story: DeskStory, notes: string, docs: FetchedDoc[], hints: Map<string, string>): Promise<Draft> {
    const messages = [this.writeRequest(story, notes, docs)];
    return this.runWriter(story, messages, docs, hints);
  }

  private async repair(story: DeskStory, prev: Draft, docs: FetchedDoc[], hints: Map<string, string>, problems: string[]): Promise<Draft> {
    const fix: BetaMessageParam = {
      role: "user",
      content: "Our checks found these problems (some are written in Japanese). Fix exactly these. Do not add new facts; " +
        "drop or rewrite a sentence when its quote cannot support it. Return the whole corrected storyboard.\n" +
        problems.map(p => `- ${p}`).join("\n"),
    };
    // 前の答えは thinking ごとそのまま返す（履歴を書き換えない）
    const messages: BetaMessageParam[] = [...prev.messages, { role: "assistant", content: prev.content }, fix];
    return this.runWriter(story, messages, docs, hints);
  }

  private async runWriter(story: DeskStory, messages: BetaMessageParam[], docs: FetchedDoc[], hints: Map<string, string>): Promise<Draft> {
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
    const { sb, errors } = toStoryboard(raw, story, hints);
    if (!sb) return { ...base, errors };
    const check = checkFacts(sb, docs, { now: this.now(), allowedHosts: [...OUTLETS], maxLeadAgeHours: MAX_LEAD_AGE_HOURS });
    return { ...base, sb, errors: check.errors };
  }

  private async refute(story: DeskStory, sb: Storyboard, docs: FetchedDoc[]): Promise<string[]> {
    const msg = await this.call(story, "refute", {
      max_tokens: MAX_TOKENS.refute,
      system: this.prompts.refute,
      messages: [{ role: "user", content: refuteRequest(sb, docs) }],
      output_config: { effort: "high", format: { type: "json_schema", schema: REFUTE_SCHEMA } },
    });
    let verdict: { pass?: unknown; problems?: unknown };
    try {
      verdict = JSON.parse(textOf(msg.content));
    } catch (e) {
      throw new Stop("api_error", `refute: 答えの JSON を読めない（${e instanceof Error ? e.message : e}）`);
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

function refuteRequest(sb: Storyboard, docs: FetchedDoc[]): string {
  const parts = [`Hook: ${JSON.stringify(sb.hook)}`, "", "Lines:"];
  for (const l of sb.lines) {
    parts.push(`[${l.id}] ${l.kind}`, `  say: ${JSON.stringify(l.say)}`, `  visual: ${JSON.stringify(l.visual)}`);
    if (l.kind === "fact" && l.source) {
      parts.push(
        `  outlet: ${l.source.outlet} (${l.source.url})`,
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

/** web_fetch の結果から本文（text）を集める。取得の失敗と PDF（base64）は使わない。同じ URL は長い方を残す。 */
export function extractDocs(blocks: readonly BetaContentBlock[]): FetchedDoc[] {
  const byUrl = new Map<string, FetchedDoc>();
  for (const b of blocks) {
    if (b.type !== "web_fetch_tool_result" || b.content.type !== "web_fetch_result") continue;
    const r = b.content;
    const source = r.content?.source;
    if (source?.type !== "text" || typeof source.data !== "string" || !source.data.trim()) continue;
    const doc: FetchedDoc = {
      url: r.url,
      ...(r.content.title ? { title: r.content.title } : {}),
      text: source.data,
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
 * 検索結果の page_age を、その URL の記事の公開日時の手がかりにする（canonicalUrl → ISO 8601）。
 * "April 30, 2025" のように年が書いてあり読めるものだけ。"2 days ago" などは使わない。
 */
export function extractPublishedHints(blocks: readonly BetaContentBlock[]): Map<string, string> {
  const hints = new Map<string, string>();
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      const iso = toIso(r.page_age);
      if (iso && !hints.has(canonicalUrl(r.url))) hints.set(canonicalUrl(r.url), iso);
    }
  }
  return hints;
}

function toIso(s: string | null | undefined): string | null {
  const t = String(s ?? "").trim();
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
 * 構造化出力の平らな JSON を台本の型に直す。version・date・storyIndex・countryCode と出典の公開日時はコードが入れる。
 * 形の誤りがあれば sb は返さない（直しの呼び出しに errors を渡す）。
 */
export function toStoryboard(raw: unknown, story: DeskStory, hints: Map<string, string>): { sb?: Storyboard; errors: string[] } {
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
    const s = l.source as { outlet?: unknown; url?: unknown; quote?: unknown } | null | undefined;
    if (s && typeof s === "object") {
      const url = typeof s.url === "string" ? s.url.trim() : "";
      const publishedAt = hints.get(canonicalUrl(url));
      line.source = {
        outlet: isStr(s.outlet) ? s.outlet.trim() : (hostOf(url) ?? ""),
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

/** HTML を本文の文字列にする。<article> があればその中だけを使う。 */
export function htmlToText(html: string): HttpPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const article = /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0];
  const body = article && article.length > 500 ? article : html;
  const decode = (s: string) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
  const text = decode(body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|section|article|header|footer|figure|figcaption|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n").map(s => s.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { ...(title ? { title: decode(title).replace(/\s+/g, " ").trim() } : {}), text };
}

async function fetchPageText(url: string): Promise<HttpPage | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
      headers: { "user-agent": "DailyWorld60-factcheck/1.0", accept: "text/html,application/xhtml+xml,text/plain" },
    });
    if (!res.ok || !isAllowedUrl(res.url || url)) return null;
    if (!/html|text\/plain/i.test(res.headers.get("content-type") ?? "")) return null;
    return htmlToText(await res.text());
  } catch {
    return null;
  }
}
