import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  NewsDesk, extractDocs, extractPageAges, fetchPageText, htmlToText, robotsAllows, stripRelatedLinks, toStoryboard,
  type DeskClient, type HttpPage, type PageDates,
} from "./NewsDesk.js";
import { CostMeter, costOf, RESERVE } from "./CostMeter.js";
import { OUTLETS, OUTLET_NAMES, isAllowedUrl, outletName } from "./outlets.js";
import type { DeskResult, DeskStory, NewsDeskPort } from "../../application/ports/NewsDeskPort.js";
import { INFRA_FAILURES, STATUS_FILE, storyboardFile } from "../../domain/storyboard/ExplainerArm.js";
import type { Experiment } from "../../domain/experiment/Experiment.js";
import { writeExplainers, capFromEnv, registryExperiments, DEFAULT_STORY_CAP_USD, USAGE_FILE } from "../../scripts/write-explainers.js";

type Msg = Anthropic.Beta.BetaMessage;
type Block = Anthropic.Beta.BetaContentBlock;
type Body = Parameters<DeskClient["beta"]["messages"]["stream"]>[0];

const NOW = new Date("2026-11-01T12:00:00Z");
const REUTERS = "https://www.aljazeera.com/news/2026/11/1/ukraine-launches-505-drones-at-russia/";
const KYIV = "https://kyivindependent.com/ukraine-drone-strike-refineries/";
const PDF = "https://www.abc.net.au/news/report.pdf";
const DEAD = "https://www.cbsnews.com/news/drones-russia-ukraine/";

const REUTERS_TEXT = [
  "Ukraine launched 505 drones at Russia overnight, the Russian defence ministry said on Saturday.",
  "Russia's defence ministry said its air defences destroyed 485 of the drones over 14 regions.",
  "The attack targeted oil refineries in the Ryazan and Saratov regions, local governors said.",
  "Ryazan is about 180 km southeast of Moscow.",
].join("\n");
const KYIV_TEXT = [
  "Ukraine's General Staff confirmed strikes on the Ryazan oil refinery overnight on Nov. 1.",
  "Kyiv has not confirmed how many drones were used in the attack.",
].join("\n");

const STORY: DeskStory = {
  date: "2026-11-01",
  index: 2,
  countryCode: "UA",
  countryName: "Ukraine",
  headline: "Ukraine hits Russian refineries with 505 drones",
  summary: "Russia says Ukraine sent 505 drones overnight.",
  sourceName: "Reuters",
  sourceUrl: REUTERS,
  places: ["Ryazan"],
};

let seq = 0;
function message(content: Block[], o: { stop_reason?: Msg["stop_reason"]; model?: string; usage?: Partial<Msg["usage"]>; stop_details?: Msg["stop_details"] } = {}): Msg {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: o.model ?? "claude-opus-5-5",
    content,
    stop_reason: o.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: o.stop_details ?? null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: null, fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null,
      server_tool_use: null, service_tier: "standard", speed: null, ...o.usage,
    },
  };
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null });
const thinking = (): Block => ({ type: "thinking", thinking: "", signature: "EqQBCgIYAhIM" });
const toolUse = (id: string, name: "web_search" | "web_fetch", input: Record<string, unknown>): Block =>
  ({ type: "server_tool_use", id, name, input } as Block);
const searchResult = (id: string, results: Array<{ url: string; title: string; page_age: string | null }>): Block => ({
  type: "web_search_tool_result",
  tool_use_id: id,
  content: results.map(r => ({ type: "web_search_result", encrypted_content: "EqgfCioIARgBIiQ3YTAw", ...r })),
});
const fetchText = (id: string, url: string, data: string, title: string | null): Block => ({
  type: "web_fetch_tool_result",
  tool_use_id: id,
  content: {
    type: "web_fetch_result",
    url,
    retrieved_at: "2026-11-01T10:30:00Z",
    content: { type: "document", source: { type: "text", media_type: "text/plain", data }, title, citations: null },
  },
});
const fetchPdf = (id: string, url: string): Block => ({
  type: "web_fetch_tool_result",
  tool_use_id: id,
  content: {
    type: "web_fetch_result",
    url,
    retrieved_at: "2026-11-01T10:31:00Z",
    content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmo" }, title: null, citations: null },
  },
});
const fetchError = (id: string, code: "url_not_accessible" | "url_not_allowed"): Block => ({
  type: "web_fetch_tool_result",
  tool_use_id: id,
  content: { type: "web_fetch_tool_result_error", error_code: code },
});

/** 1回目は途中で pause_turn、2回目で残りを取って終わる調査。 */
const researchPaused = () => message([
  text("I'll look for reports on this strike."),
  toolUse("srvtoolu_01", "web_fetch", { url: REUTERS }),
  fetchText("srvtoolu_01", REUTERS, REUTERS_TEXT, "Ukraine launches 505 drones at Russia | Al Jazeera"),
  toolUse("srvtoolu_02", "web_search", { query: "Ryazan refinery drone attack" }),
  searchResult("srvtoolu_02", [
    { url: REUTERS, title: "Ukraine launches 505 drones at Russia", page_age: "November 1, 2026" },
    { url: KYIV, title: "Ukraine strikes refineries", page_age: "2 hours ago" },
  ]),
  toolUse("srvtoolu_03", "web_fetch", { url: DEAD }),
  fetchError("srvtoolu_03", "url_not_accessible"),
  toolUse("srvtoolu_04", "web_fetch", { url: PDF }),
  fetchPdf("srvtoolu_04", PDF),
], { stop_reason: "pause_turn", usage: { server_tool_use: { web_search_requests: 1, web_fetch_requests: 3 } } });

const researchDone = () => message([
  toolUse("srvtoolu_05", "web_fetch", { url: KYIV }),
  fetchText("srvtoolu_05", KYIV, KYIV_TEXT, "Ukraine strikes refineries"),
  text("EVENT: Ukraine launched a large drone attack on Russia overnight.\nFACTS: ..."),
], { usage: { server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 } } });

const V = (v: Record<string, unknown>) => ({ places: null, value: null, label: null, items: null, from: null, to: null, who: null, text: null, ...v });
const Q = {
  a1: "Ukraine launched 505 drones at Russia overnight, the Russian defence ministry said on Saturday.",
  a2: "Russia's defence ministry said its air defences destroyed 485 of the drones over 14 regions.",
  a3: "The attack targeted oil refineries in the Ryazan and Saratov regions, local governors said.",
  a4: "Ryazan is about 180 km southeast of Moscow.",
  b1: "Kyiv has not confirmed how many drones were used in the attack.",
};
const src = (url: string, quote: string) => ({ url, quote });

function goodBoard(patch: (lines: ReturnType<typeof goodLines>) => void = () => {}) {
  const lines = goodLines();
  patch(lines);
  return { hook: "505 DRONES AT RUSSIA OVERNIGHT", whyPicked: "The drone count is the clearest number.", lines };
}
function goodLines() {
  return [
    { id: "l1", kind: "fact", say: "Ukraine launched 505 drones at Russia overnight, Russia says.", source: src(REUTERS, Q.a1), visual: V({ kind: "counter", value: 505, label: "drones" }) },
    { id: "l2", kind: "fact", say: "Russia says it destroyed 485 of them.", source: src(REUTERS, Q.a2), visual: V({ kind: "counter", value: 485, label: "shot down, Russia says" }) },
    { id: "l3", kind: "fact", say: "The drones targeted oil refineries in Ryazan and Saratov.", source: src(REUTERS, Q.a3), visual: V({ kind: "map_zoom", places: ["Ryazan", "Saratov"] }) },
    { id: "l4", kind: "fact", say: "Ryazan is about 180 km from Moscow.", source: src(REUTERS, Q.a4), visual: V({ kind: "route", from: "Moscow", to: "Ryazan" }) },
    { id: "l5", kind: "fact", say: "Kyiv has not confirmed how many drones it used.", source: src(KYIV, Q.b1), visual: V({ kind: "quote_card", who: "Kyiv Independent", text: "Kyiv has not confirmed how many drones were used" }) },
    { id: "l6", kind: "framing", say: "Remember that number tonight: 505 drones at Russia.", source: null as ReturnType<typeof src> | null, visual: V({ kind: "counter", value: 505, label: "drones" }) },
  ];
}

const writeReply = (board: unknown) => message([thinking(), text(JSON.stringify(board))], { usage: { input_tokens: 9000, output_tokens: 3000 } });
const refuteReply = (pass: boolean, problems: Array<{ lineId: string; problem: string }> = []) =>
  message([thinking(), text(JSON.stringify({ pass, problems }))], { usage: { input_tokens: 2000, output_tokens: 1500 } });

/** 関数は呼び出しに渡った signal を受け取る（止まらない応答を作るため）。 */
type Canned = Msg | Error | ((signal?: AbortSignal) => Promise<Msg>);
class FakeClient implements DeskClient {
  readonly bodies: Body[] = [];
  readonly timeouts: Array<number | undefined> = [];
  constructor(private readonly script: Canned[]) {}
  beta = {
    messages: {
      stream: (body: Body, options?: { timeout?: number; signal?: AbortSignal }) => {
        this.bodies.push(structuredClone(body));
        this.timeouts.push(options?.timeout);
        const next = this.script.shift();
        return {
          finalMessage: async (): Promise<Msg> => {
            if (!next) throw new Error("canned responses ran out");
            if (next instanceof Error) throw next;
            if (typeof next === "function") return next(options?.signal);
            return next;
          },
        };
      },
    },
  };
  get left() {
    return this.script.length;
  }
}

/** signal が切れるまで返らない呼び出し。切れたら SDK と同じ APIUserAbortError。 */
const hang = (signal?: AbortSignal) => new Promise<Msg>((_, reject) => {
  const abort = () => reject(new Anthropic.APIUserAbortError());
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
});

const PROMPTS = { research: "RESEARCH", writer: "WRITER", refute: "REFUTE" };
type DeskOpts = {
  cap?: number;
  /** その本の予算を押さえてから走らせる（write-explainers と同じ）。 */
  budget?: number;
  httpGet?: (url: string) => Promise<HttpPage | null>;
  signal?: AbortSignal;
  stepTimeoutMs?: { research?: number; write?: number; refute?: number };
};
function desk(script: Canned[], o: DeskOpts = {}) {
  const client = new FakeClient(script);
  const meter = new CostMeter(o.cap ?? 10);
  if (o.budget !== undefined) assert.ok(meter.openStory(STORY.index, o.budget));
  const httpCalls: string[] = [];
  const d = new NewsDesk({
    client,
    meter,
    now: () => NOW,
    prompts: PROMPTS,
    httpGet: async url => { httpCalls.push(url); return o.httpGet ? o.httpGet(url) : null; },
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.stepTimeoutMs ? { stepTimeoutMs: o.stepTimeoutMs } : {}),
  });
  return { d, client, meter, httpCalls };
}

const userText = (b: Body, i: number) => {
  const c = b.messages[i]?.content;
  return typeof c === "string" ? c : (c ?? []).map(x => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
};

test("extractDocs: web_fetch の本文だけを集め、取得の誤りと PDF は使わない", () => {
  const blocks = [...researchPaused().content, ...researchDone().content];
  const docs = extractDocs(blocks);
  assert.deepEqual(docs.map(d => d.url), [REUTERS, KYIV]);
  assert.deepEqual(docs[0], {
    url: REUTERS, title: "Ukraine launches 505 drones at Russia | Al Jazeera", text: REUTERS_TEXT, retrievedAt: "2026-11-01T10:30:00Z", via: "web_fetch",
  });
  const dup = extractDocs([fetchText("a", REUTERS, "short", null), fetchText("b", `${REUTERS}?utm=x`, REUTERS_TEXT, null)]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].text, REUTERS_TEXT);
  assert.equal("title" in dup[0], false);
});

test("stripRelatedLinks: 別記事へのリンクの行（Read also: など・Markdown の飾りつき）を落とし、本文の文は残す", () => {
  const body = [
    "Air defenses had shot down or suppressed 105 drones.",
    "Read also: Three injured, homes damaged in Russian drone strike on Kharkiv",
    "**Read also:** [Casualties reported as Russian forces attack Dnipropetrovsk region overnight](https://www.ukrinform.net/x)",
    "READ MORE: Russia launches 300 drones at Kyiv",
    "- Related: Zelensky meets Trump",
    "Related",
    "See also: Power outages in Kyiv region",
    "## Most read",
    "> More from Ukrinform: Odesa port attacked",
    "[Read more](https://www.ukrinform.net/rubric-ato/2-y.html)",
    "Related talks are expected next week, officials said.",
    "Read more about the 40 missiles below.",
    "Readers asked about the 40 missiles.",
    "read also",
    "Erdogan calls Black Sea ship attacks unacceptable after talks",
    "Oil refineries Oil Russian oil",
    "Russia launched 300 drones overnight, the air force said.",
  ].join("\n");
  assert.equal(stripRelatedLinks(body), [
    "Air defenses had shot down or suppressed 105 drones.",
    "Related talks are expected next week, officials said.",
    "Read more about the 40 missiles below.",
    "Readers asked about the 40 missiles.",
    "Russia launched 300 drones overnight, the air force said.",
  ].join("\n"), "見出しだけの行の後は、文の終わる行まで見出しとして落とす");
  const [doc] = extractDocs([fetchText("a", KYIV, `${KYIV_TEXT}\nRead also: 650 drones hit Lviv`, null)]);
  assert.equal(doc.text, KYIV_TEXT, "web_fetch の本文からも落とす");
  assert.deepEqual(extractDocs([fetchText("b", KYIV, "Read also: only a link", null)]), [], "リンクしか無いページは本文が無いのと同じ");
});

test("stripRelatedLinks: 媒体ごとの関連記事の並び（AJ の list N of M・JT の WHAT’S TRENDING / Editors' Picks・CBS の More・Markdown のリンク1本の行）", () => {
  const before = "Malicious actors from North Korea were observed laundering the stolen assets, the FBI said.";
  const after = "The US agency blamed the operation on a group called TraderTraitor.";
  const aj = [
    before,
    "Recommended Stories",
    "list of 3 items",
    "list 1 of 3 Netanyahu’s pitch: Can Israel use crypto to evade economic sanctions?",
    "list 2 of 3 Tracking the money: The biggest donors in the 2026 US midterm elections",
    "list 3 of 3 Russia jails IT worker for 13 years for donating money to Ukraine.",
    "end of list",
    after,
  ].join("\n");
  assert.equal(stripRelatedLinks(aj), [before, after].join("\n"), "見出しが ? や . で終わっても並びの印の行は落とす");
  assert.equal(stripRelatedLinks(aj.replace("Recommended Stories\n", "")), [before, after].join("\n"), "見出しの行が無くても落とす");

  const jt = ["WHAT’S TRENDING", "Editors' Picks", "Netanyahu bloc finishes ahead in Israel vote, but well short of majority", "Renowned Japanese pianist found guilty of driving at 144 kph", after].join("\n");
  assert.equal(stripRelatedLinks(jt), after);
  assert.equal(stripRelatedLinks(["**Editor’s picks**", "Japan has mastered the red carpet", after].join("\n")), after);

  const cbs = [before, "North Korea", "More", "Treasury sanctions North Koreans, Russians over IT worker scheme", after].join("\n");
  assert.equal(stripRelatedLinks(cbs), [before, "North Korea", after].join("\n"), "More は1行まるごとのときだけ見出し");
  const more = ["More than 300 drones were launched, the air force said.", "More drones are expected tonight", "More: Kyiv braces for blackouts"].join("\n");
  assert.equal(stripRelatedLinks(more), more, "More で始まる本文の行は落とさない");

  const md = [
    before,
    "[Trump pardons Canadian Binance CEO who failed to stop illegal activity on crypto platform](https://www.cbc.ca/news/business/binance-founder-changpeng-zhao-pardoned-trump-9.6950284)",
    "- [Binance says $6.3B US hacked in what could be largest cryptocurrency theft ever.](https://www.cbc.ca/news/business/binance-north-korea-9.7402446)",
    "**[Netanyahu’s pitch: Can Israel use crypto?](https://www.aljazeera.com/news/2026/10/25/x)**",
    "2. [Russia jails IT worker for 13 years](https://www.aljazeera.com/news/2026/10/27/y)",
    "Binance said it has set aside around $6.34 billion, according to [Reuters](https://www.reuters.com/x).",
    after,
  ].join("\n");
  assert.equal(stripRelatedLinks(md), [before, "Binance said it has set aside around $6.34 billion, according to [Reuters](https://www.reuters.com/x).", after].join("\n"),
    "1行まるごとリンク1本の行は文の終わりの記号があっても落とし、文の中のリンクは残す");
});

test("extractPageAges: page_age（最終更新）を年のある書き方と相対の書き方から ISO にする", () => {
  const ages = extractPageAges(researchPaused().content, NOW);
  assert.equal(ages.size, 2);
  assert.equal(new Date(ages.get("aljazeera.com/news/2026/11/1/ukraine-launches-505-drones-at-russia")!).getUTCFullYear(), 2026);
  assert.equal(ages.get("kyivindependent.com/ukraine-drone-strike-refineries"), "2026-11-01T10:00:00.000Z", "2 hours ago は now から引く");
  const more = extractPageAges([searchResult("s", [
    { url: KYIV, title: "x", page_age: "2026-10-31" },
    { url: REUTERS, title: "x", page_age: "3 days ago" },
    { url: DEAD, title: "x", page_age: "an hour ago" },
    { url: PDF, title: "x", page_age: "last week" },
  ])], NOW);
  assert.equal(more.get("kyivindependent.com/ukraine-drone-strike-refineries"), "2026-10-31T00:00:00.000Z");
  assert.equal(more.get("aljazeera.com/news/2026/11/1/ukraine-launches-505-drones-at-russia"), "2026-10-29T12:00:00.000Z");
  assert.equal(more.get("cbsnews.com/news/drones-russia-ukraine"), "2026-11-01T11:00:00.000Z");
  assert.equal(more.has("abc.net.au/news/report.pdf"), false);
});

test("通しの流れ: pause_turn を続け、照合と反証を通った台本を返す", async () => {
  const { d, client, meter } = desk([researchPaused(), researchDone(), writeReply(goodBoard()), refuteReply(true)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  assert.deepEqual(r.errors, []);
  assert.equal(client.left, 0);
  assert.deepEqual(r.docs.map(x => x.url), [REUTERS, KYIV]);

  const sb = r.storyboard!;
  assert.equal(sb.version, 1);
  assert.equal(sb.date, "2026-11-01");
  assert.equal(sb.storyIndex, 2);
  assert.equal(sb.countryCode, "UA");
  assert.equal(sb.lines.length, 6);
  assert.ok(sb.lines[0].source?.publishedAt, "ページの公開日時が無ければ検索結果の page_age（最終更新）を入れる");
  assert.equal(sb.lines[4].source?.publishedAt, "2026-11-01T10:00:00.000Z");
  assert.equal(sb.lines[0].source?.outlet, "Al Jazeera", "媒体名は URL から入れる");
  assert.equal(sb.lines[4].source?.outlet, "Kyiv Independent");
  assert.equal(sb.lines[5].source, undefined);
  assert.deepEqual(sb.lines[2].visual, { kind: "map_zoom", places: ["Ryazan", "Saratov"] });

  const [r1, r2, w, f] = client.bodies;
  for (const b of client.bodies) {
    assert.equal(b.model, "claude-opus-5-5");
    assert.deepEqual(b.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(b.fallbacks, "default");
    assert.equal(b.thinking, undefined);
  }
  assert.equal(r1.system, "RESEARCH");
  assert.equal(r1.messages.length, 1);
  assert.match(userText(r1, 0), new RegExp(REUTERS.replace(/[.?/]/g, "\\$&")), "web_fetch が取れるように出典の URL をユーザーのメッセージに入れる");
  assert.equal(r1.output_config?.effort, "medium");
  const [search, fetch] = r1.tools as unknown as Array<Record<string, unknown>>;
  assert.equal(search.type, "web_search_20260209");
  assert.equal(search.max_uses, 5);
  assert.deepEqual(search.allowed_domains, OUTLETS);
  assert.equal(fetch.type, "web_fetch_20250910");
  assert.equal(fetch.max_uses, 6);
  assert.equal(fetch.max_content_tokens, 12000);
  assert.deepEqual(fetch.allowed_domains, OUTLETS);

  assert.equal(r2.messages.length, 2, "pause_turn の続きは assistant の内容をそのまま付けて送る");
  assert.equal(r2.messages[1].role, "assistant");
  assert.deepEqual(r2.messages[1].content, structuredClone(researchPaused().content));

  assert.equal(w.system, "WRITER");
  assert.equal(w.tools, undefined);
  assert.equal(w.output_config?.effort, "medium");
  assert.equal(w.output_config?.format?.type, "json_schema");
  assert.match(userText(w, 0), /<page id="1" url="https:\/\/www\.aljazeera\.com[^>]* outlet="Al Jazeera"/);
  assert.match(userText(w, 0), /Research notes:\nI'll look for reports/);

  assert.equal(f.system, "REFUTE");
  assert.equal(f.output_config?.effort, "high");
  assert.match(userText(f, 0), /^Script date: 2026-11-01\n/);
  assert.match(userText(f, 0), /\[l1\] fact\n.*\n.*\n  outlet: Al Jazeera \(https:\/\/www\.aljazeera\.com[^)]*\)\n  page published: unknown\n  page last updated \(search result\): 2026-/);
  assert.match(userText(f, 0), /\[l5\] fact\n(?:.*\n){4}  page last updated \(search result\): 2026-11-01T10:00:00\.000Z/);
  assert.match(userText(f, 0), /quote: "Ukraine launched 505 drones/);
  assert.match(userText(f, 0), /page text around the quote: ".*Russia's defence ministry said/s);

  assert.deepEqual(meter.calls().map(c => c.step), ["research", "research", "write", "refute"]);
  assert.ok(Math.abs(r.costUsd - meter.spent) < 1e-12);
  assert.ok(r.costUsd > 0);
});

test("拒否: stop_reason refusal は refusal", async () => {
  const refused = message([], { stop_reason: "refusal", usage: { input_tokens: 412, output_tokens: 0 }, stop_details: { type: "refusal", category: "cyber", explanation: "declined", recommended_model: null, fallback_credit_token: null, fallback_has_prefill_claim: null } });
  const { d, meter } = desk([refused]);
  const r = await d.write(STORY);
  assert.equal(r.status, "refusal");
  assert.match(r.errors[0], /research: 拒否された（cyber）/);
  assert.equal(meter.calls().length, 1);
});

const apiError = (status: number, type: string) => Anthropic.APIError.generate(status, { type: "error", error: { type, message: type } }, type, new Headers());

test("最初の呼び出しが API の障害（接続・401・403・429・5xx・529）なら api_error（中身と無関係なので比較から外す）。費用は見込み額を estimated で残す", async () => {
  const errs = [
    new Anthropic.APIConnectionError({ message: "socket hang up" }), new Anthropic.APIConnectionTimeoutError(),
    apiError(401, "authentication_error"), apiError(403, "permission_error"), apiError(429, "rate_limit_error"),
    apiError(500, "api_error"), apiError(503, "api_error"), apiError(529, "overloaded_error"),
  ];
  for (const err of errs) {
    const { d, meter } = desk([err], { cap: RESERVE.research * 2 });
    const r = await d.write(STORY);
    assert.equal(r.status, "api_error", r.errors[0]);
    assert.ok(INFRA_FAILURES.includes(r.status));
    assert.match(r.errors[0], /^research: /);
    assert.deepEqual(meter.calls().map(c => [c.step, c.costUsd, c.estimated]), [["research", RESERVE.research, true]], "失敗した呼び出しも $0 にしない");
    assert.equal(r.costUsd, RESERVE.research);
    assert.equal(meter.completedCalls(STORY.index), 0);
    assert.ok(meter.reserve("research", STORY.index), "押さえた見込み額は estimated に移り、押さえ中には残らない");
  }
});

test("最初の呼び出しの段の時間切れは incomplete（調べる量は本の中身で決まりうるので腕に数える）", async () => {
  const slow = desk([hang], { stepTimeoutMs: { research: 30 } });
  const r1 = await slow.d.write(STORY);
  assert.equal(r1.status, "incomplete");
  assert.equal(INFRA_FAILURES.includes(r1.status), false);
  assert.match(r1.errors[0], /^research: 1回の時間 0\.03 秒を過ぎた: /);
  assert.equal(slow.meter.completedCalls(STORY.index), 0);
  assert.deepEqual(slow.meter.calls().map(c => c.estimated), [true]);
});

test("最初の呼び出しの 400・422 は api_error（媒体の一覧などの設定の誤りで全本に起きるので比較から外す）", async () => {
  for (const err of [apiError(400, "invalid_request_error"), apiError(422, "invalid_request_error")]) {
    assert.ok(err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError);
    const { d, meter } = desk([err]);
    const r = await d.write(STORY);
    assert.equal(r.status, "api_error", r.errors[0]);
    assert.ok(INFRA_FAILURES.includes(r.status));
    assert.match(r.errors[0], new RegExp(`^research: .*${err.status}`));
    assert.equal(meter.completedCalls(STORY.index), 0);
  }
});

test("1回でも呼び出しが返った後の API の誤りは incomplete（解説形式の腕に数える）", async () => {
  const { d, meter } = desk([researchPaused(), researchDone(), new Anthropic.APIConnectionError({ message: "reset" })]);
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.equal(INFRA_FAILURES.includes(r.status), false);
  assert.match(r.errors[0], /^write: /);
  assert.equal(r.docs.length, 2);
  assert.deepEqual(meter.calls().map(c => [c.step, c.estimated ?? false]), [["research", false], ["research", false], ["write", true]]);
});

test("コードの誤りは握りつぶさない", async () => {
  const { d } = desk([new TypeError("bug")]);
  await assert.rejects(d.write(STORY), /bug/);
});

test("上限: 調べる前に上限に届くなら呼ばずに cap", async () => {
  const { d, client } = desk([researchDone()], { cap: RESERVE.research - 0.01 });
  const r = await d.write(STORY);
  assert.equal(r.status, "cap");
  assert.equal(client.bodies.length, 0);
  assert.equal(r.costUsd, 0);
});

test("上限: 調べた後で上限に届けば incomplete", async () => {
  // 0.024（1回目）+ 1.94（2回目）+ 書く段の見込み 0.15 > 2
  const heavy = message(researchDone().content, { usage: { input_tokens: 480_000, output_tokens: 1000 } });
  const { d, client } = desk([researchPaused(), heavy], { cap: 2 });
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /^write: 1回の実行の上限 \$2/);
  assert.equal(client.bodies.length, 2);
});

test("本の予算: 本の中の呼び出しはその本の予算から押さえ、使い切ったら incomplete", async () => {
  // 調べる 0.038 + 書く 0.096 + 反証 0.63 の後、直しの書く段の見込み 0.15 が予算 0.8 に収まらない
  const heavyRefute = message([thinking(), text(JSON.stringify({ pass: false, problems: [{ lineId: "l3", problem: "x" }] }))], { usage: { input_tokens: 150_000, output_tokens: 1500 } });
  const { d, client, meter } = desk([researchPaused(), researchDone(), writeReply(goodBoard()), heavyRefute, writeReply(goodBoard()), refuteReply(true)], { cap: 10, budget: 0.8 });
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /^write: この本の予算 \$0\.8 に届く/);
  assert.equal(client.bodies.length, 4);
  assert.ok(Math.abs(meter.storyCost(STORY.index) - 0.764) < 1e-9);
});

test("本の予算: 予算の中で上限を超えても、ほかの本の予算は削らない", () => {
  const m = new CostMeter(2.5);
  assert.ok(m.openStory(1, 1.2));
  assert.ok(m.openStory(2, 1.2));
  assert.equal(m.openStory(3, 1.2), false, "2.4 + 1.2 > 2.5");
  assert.equal(m.openStory(1, 0.01), false, "同じ本を2回は押さえない");
  const h = m.reserve("research", 1)!;
  m.record(h, "claude-opus-5-5", { input_tokens: 400_000 }); // 1.6（見込みの 0.5 を超えた）
  assert.equal(m.reserve("write", 1), null, "1 は自分の予算 1.2 を使い切った");
  assert.ok(m.reserve("write", 2), "2 の予算は 1 の使い過ぎに削られない");
  assert.equal(m.reserve("refute", 99), null, "予算を持たない本は上限の残り（2.5 - 1.6 - 1.2 < 0.15）から押さえる");
});

test("max_tokens で切れたら incomplete（長さは中身で決まる）", async () => {
  const { d } = desk([message([text("EVENT")], { stop_reason: "max_tokens" })]);
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /max_tokens/);
});

test("pause_turn が 4 回の続きでも終わらなければ incomplete", async () => {
  const paused = () => message([text("...")], { stop_reason: "pause_turn" });
  const { d, client } = desk([paused(), paused(), paused(), paused(), paused(), researchDone()]);
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.equal(client.bodies.length, 5);
  assert.equal(client.bodies[4].messages.length, 2, "続きは assistant を1つにまとめて送る");
});

test("反証の答えの JSON が読めなければ incomplete", async () => {
  const broken = message([thinking(), text("{\"pass\": fal")]);
  const { d } = desk([researchPaused(), researchDone(), writeReply(goodBoard()), broken]);
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /^refute: 答えの JSON を読めない/);
});

test("締め切り: 最初の呼び出しの途中で切れたら api_error、返った後で切れたら incomplete", async () => {
  const early = desk([hang], { signal: AbortSignal.timeout(30) });
  const r1 = await early.d.write(STORY);
  assert.equal(r1.status, "api_error");
  assert.match(r1.errors[0], /^research: 全体の締め切りで止めた: /);
  assert.deepEqual(early.meter.calls().map(c => c.estimated), [true]);

  const late = desk([researchPaused(), researchDone(), hang], { signal: AbortSignal.timeout(30) });
  const r2 = await late.d.write(STORY);
  assert.equal(r2.status, "incomplete");
  assert.match(r2.errors[0], /^write: 全体の締め切りで止めた: /);

  const ac = new AbortController();
  ac.abort();
  const before = desk([researchDone()], { signal: ac.signal });
  const r3 = await before.d.write(STORY);
  assert.equal(r3.status, "api_error");
  assert.equal(before.client.bodies.length, 0, "締め切りを過ぎていたら呼ばない");
});

test("段ごとの時間は signal で掛ける（流れ始めたストリームにも効く）", async () => {
  const t0 = Date.now();
  const { d, meter } = desk([researchPaused(), researchDone(), hang], { stepTimeoutMs: { write: 40 } });
  const r = await d.write(STORY);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /^write: 1回の時間 0\.04 秒を過ぎた: /);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(meter.calls().at(-1)?.estimated, true);
});

test("no_docs: 許可した媒体のページが取れなければ no_docs", async () => {
  const empty = message([toolUse("srvtoolu_9", "web_fetch", { url: REUTERS }), fetchError("srvtoolu_9", "url_not_allowed"), text("NO PAGES")]);
  const { d, httpCalls } = desk([empty]);
  const r = await d.write(STORY);
  assert.equal(r.status, "no_docs");
  assert.deepEqual(httpCalls, [REUTERS], "web_fetch で取れなかった出典はコードで取りに行く");
});

test("Routine の出典を web_fetch で取れなければ HTTP で取った本文を使う（関連記事の行は落とし、ページの公開日時を page_age より優先）", async () => {
  const onlyKyiv = message([
    toolUse("srvtoolu_0", "web_search", { query: "q" }),
    searchResult("srvtoolu_0", [{ url: REUTERS, title: "x", page_age: "October 31, 2026" }]),
    toolUse("srvtoolu_1", "web_fetch", { url: REUTERS }), fetchError("srvtoolu_1", "url_not_accessible"),
    toolUse("srvtoolu_2", "web_fetch", { url: KYIV }), fetchText("srvtoolu_2", KYIV, KYIV_TEXT, null), text("notes"),
  ]);
  const page = { title: "Al Jazeera", text: `${REUTERS_TEXT}\nRead also: 650 drones hit Lviv\n${"More text. ".repeat(20)}`, publishedAt: "2026-11-01T06:00:00.000Z" };
  const { d, client } = desk([onlyKyiv, writeReply(goodBoard()), refuteReply(true)], { httpGet: async () => page });
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  const http = r.docs.find(x => x.via === "http")!;
  assert.equal(http.url, REUTERS);
  assert.equal(http.retrievedAt, NOW.toISOString());
  assert.doesNotMatch(http.text, /Read also|Lviv/);
  assert.equal(r.storyboard!.lines[0].source?.publishedAt, "2026-11-01T06:00:00.000Z");
  assert.match(userText(client.bodies[1], 0), /<page id="2" url="https:\/\/www\.aljazeera\.com[^>]*title="Al Jazeera">/);
  assert.match(userText(client.bodies[2], 0), /page published: 2026-11-01T06:00:00\.000Z\n  page last updated \(search result\): 2026-10-3[01]T/);
});

test("照合で落ちたら1回直させる: 直った台本は ok", async () => {
  const wrong = goodBoard(ls => { ls[1].say = "Russia says it destroyed 490 of them."; });
  const { d, client } = desk([researchPaused(), researchDone(), writeReply(wrong), writeReply(goodBoard()), refuteReply(true)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  const fix = client.bodies[3];
  assert.equal(fix.messages.length, 3);
  assert.equal(fix.messages[1].role, "assistant");
  assert.deepEqual(fix.messages[1].content, structuredClone(writeReply(wrong).content), "前の答えは thinking ごとそのまま返す");
  assert.match(userText(fix, 2), /Fix exactly these/);
  assert.match(userText(fix, 2), /- l2: 数 490 が引用文に無い/);
  assert.deepEqual(fix.messages[0], client.bodies[2].messages[0], "前半（ページ本文）は最初の書く段と同じ");
});

test("照合で2回落ちたら check_failed（反証は呼ばない）", async () => {
  const wrong = goodBoard(ls => { ls[1].say = "Russia says it destroyed 490 of them."; });
  const { d, client } = desk([researchPaused(), researchDone(), writeReply(wrong), writeReply(wrong), refuteReply(true)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "check_failed");
  assert.match(r.errors.join("\n"), /l2: 数 490/);
  assert.equal(client.left, 1);
  assert.equal(r.storyboard, undefined);
});

test("反証で落ちたら1回直させる: 直して照合と反証を通れば ok", async () => {
  const { d, client } = desk([
    researchPaused(), researchDone(), writeReply(goodBoard()),
    refuteReply(false, [{ lineId: "l3", problem: "The page says refineries in two regions, not that they were hit." }]),
    writeReply(goodBoard(ls => { ls[2].say = "The attack targeted oil refineries in Ryazan and Saratov."; })),
    refuteReply(true),
  ]);
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  assert.equal(r.storyboard!.lines[2].say, "The attack targeted oil refineries in Ryazan and Saratov.");
  assert.match(userText(client.bodies[4], 2), /- l3: The page says refineries/);
  assert.equal(client.bodies.length, 6);
});

test("反証で2回落ちたら refuted", async () => {
  const problem = [{ lineId: "hook", problem: "OVERNIGHT is not supported." }];
  const { d } = desk([researchPaused(), researchDone(), writeReply(goodBoard()), refuteReply(false, problem), writeReply(goodBoard()), refuteReply(false, problem)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "refuted");
  assert.deepEqual(r.errors, ["hook: OVERNIGHT is not supported."]);
});

test("照合の直しを使ったあとに反証で落ちたら refuted（直しは1回だけ）", async () => {
  const wrong = goodBoard(ls => { ls[1].say = "Russia says it destroyed 490 of them."; });
  const { d, client } = desk([researchPaused(), researchDone(), writeReply(wrong), writeReply(goodBoard()), refuteReply(false, [{ lineId: "l1", problem: "x" }])]);
  const r = await d.write(STORY);
  assert.equal(r.status, "refuted");
  assert.equal(client.left, 0);
});

test("反証が理由なしで不合格にしたら不合格のまま扱う", async () => {
  const { d } = desk([researchPaused(), researchDone(), writeReply(goodBoard()), refuteReply(false), writeReply(goodBoard()), refuteReply(false)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "refuted");
  assert.match(r.errors[0], /理由が無い/);
});

test("toStoryboard: 形の崩れた visual は誤りにする", () => {
  const board = goodBoard(ls => {
    ls[0].visual = V({ kind: "counter", value: null, label: "drones" });
    ls[2].visual = V({ kind: "map_zoom", places: [] });
    ls[3].visual = V({ kind: "spiral" });
  });
  const { sb, errors } = toStoryboard(board, STORY, new Map());
  assert.equal(sb, undefined);
  assert.deepEqual(errors, [
    "l1: visual counter の value が無いか形が違う",
    "l3: visual map_zoom の places が無いか形が違う",
    "l4: visual の kind が不明（spiral）",
  ]);
  assert.deepEqual(toStoryboard({ hook: "x" }, STORY, new Map()).errors, ["全体: 台本の JSON の形が違う（lines が無い）"]);
});

test("toStoryboard: 媒体名は URL から決め、書き手の outlet は使わない。公開日時はページの値を page_age より優先", () => {
  const board = goodBoard(ls => { ls[3].source = { ...src(REUTERS, Q.a4), outlet: "Reuters" } as ReturnType<typeof src>; });
  const dates = new Map<string, PageDates>([
    ["aljazeera.com/news/2026/11/1/ukraine-launches-505-drones-at-russia", { publishedAt: "2026-11-01T06:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z" }],
    ["kyivindependent.com/ukraine-drone-strike-refineries", { updatedAt: "2026-10-20T09:00:00.000Z" }],
  ]);
  const { sb } = toStoryboard(board, STORY, dates);
  assert.equal(sb!.lines[3].source?.outlet, "Al Jazeera");
  assert.equal(sb!.lines[3].source?.publishedAt, "2026-11-01T06:00:00.000Z");
  assert.equal(sb!.lines[4].source?.publishedAt, "2026-10-20T09:00:00.000Z", "最終更新しか無ければそれを入れる（古ければ確実に古い）");
});

test("書く段の JSON が読めなければ直させる", async () => {
  const broken = message([text("{\"hook\": ")]);
  const { d, client } = desk([researchPaused(), researchDone(), broken, writeReply(goodBoard()), refuteReply(true)]);
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  assert.match(userText(client.bodies[3], 2), /台本の JSON を読めない/);
});

/** 作り物の応答を SSE（streaming の形）にする。結果のブロックは content_block_start で丸ごと届く。 */
function toSse(m: Msg): string {
  const ev: Array<Record<string, unknown>> = [];
  ev.push({ type: "message_start", message: { ...m, content: [], stop_reason: null, stop_details: null, usage: { ...m.usage, output_tokens: 0 } } });
  m.content.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "server_tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: b });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: m.stop_reason, stop_sequence: null, stop_details: m.stop_details }, usage: m.usage });
  ev.push({ type: "message_stop" });
  return ev.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("本物の SDK を通しても要求の形と応答の組み立てが合う（偽の fetch・通信なし）", async () => {
  const replies = [researchPaused(), researchDone(), writeReply(goodBoard()), refuteReply(true)];
  const seen: Array<{ url: string; beta: string; body: Record<string, any> }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input instanceof Request ? input.url : input), beta: new Headers(init?.headers).get("anthropic-beta") ?? "", body: JSON.parse(String(init?.body)) });
    const m = replies.shift();
    if (!m) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "no more" } }), { status: 500 });
    return new Response(toSse(m), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new Anthropic({ apiKey: "sk-ant-test-not-a-real-key", baseURL: "http://sdk.fake.test", fetch: fakeFetch, maxRetries: 0 });
  const meter = new CostMeter(10);
  const d = new NewsDesk({ client, meter, now: () => NOW, prompts: PROMPTS, httpGet: async () => null });
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  assert.deepEqual(r.docs.map(x => x.url), [REUTERS, KYIV]);
  assert.equal(seen.length, 4);
  for (const s of seen) {
    assert.match(s.url, /^http:\/\/sdk\.fake\.test\/v1\/messages(\?beta=true)?$/);
    assert.match(s.beta, /server-side-fallback-2026-07-01/);
    assert.equal(s.body.model, "claude-opus-5-5");
    assert.equal(s.body.stream, true);
    assert.equal(s.body.fallbacks, "default");
    assert.equal("betas" in s.body, false);
  }
  assert.deepEqual(seen[0].body.tools[0], { type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: OUTLETS, allowed_callers: ["direct"] });
  assert.deepEqual(seen[1].body.messages[1].content.map((b: { type: string }) => b.type), researchPaused().content.map(b => b.type));
  assert.deepEqual(seen[1].body.messages[1].content[1], { type: "server_tool_use", id: "srvtoolu_01", name: "web_fetch", input: { url: REUTERS } });
  assert.equal(seen[2].body.output_config.format.schema.additionalProperties, false);
  assert.equal(seen[2].body.messages[0].content[0].cache_control.type, "ephemeral");
  assert.deepEqual(meter.calls().map(c => c.usage.server_tool_use?.web_search_requests), [1, 0, undefined, undefined]);
});

test("本物の SDK: message_start の後で止まったストリームも段ごとの時間で止まり（最初の呼び出しでも incomplete）、見込み額を estimated で残す", async () => {
  const stalling = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const start = { type: "message_start", message: { ...researchDone(), content: [], stop_reason: null, usage: { input_tokens: 50_000, output_tokens: 0 } } };
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));
        init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new Anthropic({ apiKey: "sk-ant-test-not-a-real-key", baseURL: "http://sdk.fake.test", fetch: stalling, maxRetries: 0 });
  const meter = new CostMeter(10);
  const d = new NewsDesk({ client, meter, now: () => NOW, prompts: PROMPTS, httpGet: async () => null, stepTimeoutMs: { research: 150 } });
  const t0 = Date.now();
  const r = await d.write(STORY);
  assert.ok(Date.now() - t0 < 3000, `止まるまで ${Date.now() - t0}ms`);
  assert.equal(r.status, "incomplete");
  assert.match(r.errors[0], /^research: 1回の時間 0\.15 秒を過ぎた: /);
  assert.deepEqual(meter.calls().map(c => [c.step, c.costUsd, c.estimated]), [["research", RESERVE.research, true]]);
});

test("costOf: 手計算と合う", () => {
  const usage = { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 5_000, server_tool_use: { web_search_requests: 3, web_fetch_requests: 4 } };
  // 0.04 + 0.04 + 0.005 + 0.001 + 0.03
  assert.ok(Math.abs(costOf(usage) - 0.116) < 1e-12);
  const fallback = {
    input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    iterations: [
      { type: "message", model: "claude-opus-5-5", input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ],
  };
  // 答えたモデルの 0.0016 + 0.004 に、断ったモデルの 0.002 を足す
  assert.ok(Math.abs(costOf(fallback, "claude-opus-4-8") - 0.0076) < 1e-12);
  const loop = { input_tokens: 3000, output_tokens: 0, iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: 1000 }, { type: "message", model: "claude-opus-5-5", input_tokens: 2000 }] };
  assert.ok(Math.abs(costOf(loop, "claude-opus-5-5") - 0.012) < 1e-12, "代わりのモデルが答えていなければ iterations は足さない");
});

test("CostMeter: 押さえ中の見込み額も上限に数える（予算を持たない本どうし）", () => {
  const m = new CostMeter(1.0);
  const a = m.reserve("research", 1)!;
  const b = m.reserve("research", 2)!;
  assert.ok(a && b);
  assert.equal(m.reserve("write", 1), null);
  m.release(b);
  m.release(b);
  const c = m.reserve("write", 2)!;
  assert.ok(c);
  const cost = m.record(a, "claude-opus-5-5", { input_tokens: 25_000, output_tokens: 0 });
  assert.ok(Math.abs(cost - 0.1) < 1e-12);
  assert.ok(m.reserve("research", 1), "実額 0.1 + 押さえ 0.15 + 0.5 <= 1.0");
  assert.deepEqual(m.calls().map(x => [x.story, x.step]), [[1, "research"]]);
  assert.ok(Math.abs(m.storyCost(1) - 0.1) < 1e-12);
  assert.equal(m.storyCost(2), 0);
  assert.equal(m.completedCalls(1), 1);
  m.recordEstimate(c, "claude-opus-5-5");
  m.recordEstimate(c, "claude-opus-5-5");
  assert.deepEqual(m.calls().map(x => [x.story, x.step, x.costUsd, x.estimated]), [[1, "research", cost, undefined], [2, "write", RESERVE.write, true]], "estimated は1回だけ");
  assert.equal(m.completedCalls(2), 0);
});

test("CostMeter: 段ごとの見込み額は差し替えられる", () => {
  const m = new CostMeter(1.0, { reserve: { research: 0.9 } });
  assert.equal(m.reserve("research", 1)?.amount, 0.9);
  assert.equal(m.reserve("write", 1), null, "0.9 + 0.15 > 1.0");
});

test("outlets: 国営の宣伝媒体を入れない・サブドメインまで許す", () => {
  for (const bad of ["tass.ru", "tass.com", "xinhuanet.com", "presstv.ir", "rt.com", "globaltimes.cn", "kcna.kp"]) {
    assert.equal(OUTLETS.includes(bad), false, bad);
    assert.equal(isAllowedUrl(`https://${bad}/news/1`), false, bad);
  }
  for (const blocked of ["apnews.com", "reuters.com", "bbc.com", "bbc.co.uk", "theguardian.com", "nytimes.com", "news.sky.com"]) {
    assert.equal(OUTLETS.includes(blocked), false, `${blocked} は Anthropic のクローラーを断っている`);
  }
  for (const robots of ["bloomberg.com", "cnn.com", "france24.com", "haaretz.com", "nbcnews.com", "npr.org"]) {
    assert.equal(OUTLETS.includes(robots), false, `${robots} は robots.txt で Claude-User を断っている`);
    assert.equal(isAllowedUrl(`https://www.${robots}/2026/11/01/x`), false, robots);
  }
  assert.equal(isAllowedUrl("https://www.ukrinform.net/rubric-ato/1-x.html"), true);
  assert.equal(isAllowedUrl("https://www.reuters.com/world/x"), false);
  assert.equal(isAllowedUrl("https://edition.cnn.com/2026/11/01/x"), false);
  assert.equal(isAllowedUrl("https://english.aljazeera.com/x"), true);
  assert.equal(isAllowedUrl("https://notukrinform.net/x"), false);
  assert.equal(isAllowedUrl("ftp://ukrinform.net/x"), false);
  assert.equal(new Set(OUTLETS).size, OUTLETS.length);
});

test("outlets: 媒体名は表から URL で引く（全部の媒体に名前がある）", () => {
  assert.deepEqual(Object.keys(OUTLET_NAMES).sort(), [...OUTLETS].sort());
  assert.equal(outletName("https://www.ukrinform.net/rubric-ato/1-x.html"), "Ukrinform");
  assert.equal(outletName("https://english.aljazeera.com/x"), "Al Jazeera");
  assert.equal(outletName("https://abcnews.com/International/wireStory/x-137729925"), "ABC News", "abcnews.go.com の転送先");
  assert.equal(outletName("https://abcnews.go.com/International/wireStory/x-137729925"), "ABC News");
  assert.equal(outletName("https://www.example.org/x"), "example.org");
  assert.equal(outletName("not a url"), "");
});

test("htmlToText: タグと実体参照を落とし、<article> があればその中だけ", () => {
  const html = `<html><head><title>Drones &amp; refineries</title><script>var x = "<p>no</p>";</script></head><body>
    <nav>Menu Home</nav><article><h1>Headline</h1><p>Ukraine launched 505&nbsp;drones at Russia&#8217;s regions.</p>
    <p>Second &#x201C;para&#x201D;.</p>${"<p>filler sentence here.</p>".repeat(30)}</article></body></html>`;
  const page = htmlToText(html);
  assert.equal(page.title, "Drones & refineries");
  assert.match(page.text, /^Headline\nUkraine launched 505 drones at Russia’s regions\.\nSecond “para”\./);
  assert.doesNotMatch(page.text, /Menu|no<\/p>|var x/);
  assert.equal(page.publishedAt, undefined);
});

test("htmlToText: 先頭の短い <article>（別記事の札）でなく一番長いものを使い、aside と nav を落とす", () => {
  const card = `<article class="card"><a>Europe News | Poland's Tusk strikes defiant tone over court clash, vows rule of law and more about the court today</a>${"<span>Tusk said the ruling was political. </span>".repeat(4)}</article>`;
  const story = `<article><h1>Evacuees from Russian-occupied Oleshky</h1><time datetime="2026-10-31T07:15:00Z">31 Oct</time>
    <p>About 40 residents of Oleshky were evacuated on Friday, officials said.</p>
    <aside><p>Most read: 650 drones hit Lviv</p></aside><nav>Next story</nav>
    ${"<p>Officials said the evacuation continued through the night.</p>".repeat(8)}</article>`;
  const page = htmlToText(`<html><head><title>Oleshky</title></head><body>${card}${story}<article><p>short</p></article></body></html>`);
  assert.ok(card.replace(/<[^>]+>/g, "").length >= 200, "札も 200 字を超える");
  assert.match(page.text, /^Evacuees from Russian-occupied Oleshky\n/);
  assert.doesNotMatch(page.text, /Tusk|650 drones|Next story/);
  assert.equal(page.publishedAt, "2026-10-31T07:15:00.000Z", "選んだ <article> の <time datetime>");
  const noLong = htmlToText(`<html><body><article><p>Card</p></article><div>${"Body sentence. ".repeat(30)}</div><aside>Related stories</aside></body></html>`);
  assert.match(noLong.text, /^Card\nBody sentence\./, "200 字に届く <article> が無ければページ全体");
  assert.doesNotMatch(noLong.text, /Related stories/);
});

test("htmlToText: 関連記事のカード・リンク1本だけの li と div を落とし、aside の中の <article> で本文が切れない（AJ・CBC・JT・CBS の形）", () => {
  const para = (s: string) => `<p>${s}</p>`;
  const filler = "Officials said the investigation into the theft was continuing on Sunday.";
  const aj = `<article>${para("Malicious actors from North Korea were observed laundering the stolen assets, the FBI said.")}
    <section class="more-on"><h2 class="more-on__heading">Recommended Stories<!-- --> </h2><span class="screen-reader-text">list of 3 items</span><ul class="more-on__list">
    <li class="more-on__article"><span class="screen-reader-text">list 1 of 3</span><a class="more-on__link" href="/news/2026/10/25/x">Netanyahu’s pitch: Can Israel use crypto to evade economic sanctions?</a></li>
    <li class="more-on__article"><span class="screen-reader-text">list 3 of 3</span><a class="more-on__link" href="/news/2026/10/27/y">Russia jails IT worker for 13 years for donating money to Ukraine</a></li>
    </ul><span class="screen-reader-text">end of list</span></section>${para("The US agency blamed the operation on a group called TraderTraitor.")}${para(filler).repeat(4)}</article>`;
  const ajText = stripRelatedLinks(htmlToText(aj).text);
  assert.doesNotMatch(ajText, /Netanyahu|Russia jails|list \d|end of list/);
  assert.match(ajText, /the FBI said\.\nThe US agency blamed/);

  const cbc = `<article>${para("After the hack, the exchange stopped allowing customers to withdraw their funds.")}
    <ul class="similarLinksContainer-JxEul" role="list"><li class="similarLinkItem-TyY7E" role="listitem"><a class="cardWrapper-u5T0r" data-feature-instance="similar-link" href="/news/business/binance-founder-changpeng-zhao-pardoned-trump-9.6950284"><div class="card-SmBL5"><p class="title-cSJax">Trump pardons Canadian Binance CEO who failed to stop illegal activity on crypto platform</p></div></a></li></ul>
    ${para("Binance said it has set aside around $6.34 billion of company funds to cover the losses.")}${para(filler).repeat(4)}</article>`;
  const cbcText = stripRelatedLinks(htmlToText(cbc).text);
  assert.doesNotMatch(cbcText, /Trump pardons/);
  assert.match(cbcText, /withdraw their funds\.\nBinance said it has set aside around \$6\.34 billion/);

  const jt = `<html><body><ul class="menu"><li><a href="/news/japan/">Politics</a></li><li><a href="/sports/">More sports</a></li></ul>
    <article><a class="fancybox" href="/img.jpg"><div class="layout-ratio"><picture><img src="/img.jpg"></picture></div></a></article>
    <div class="article-body">${para("Taipei – The China Coast Guard is harassing shipping with its latest patrol off Taiwan’s east coast, Taiwan said.")}${para(filler).repeat(4)}</div>
    <ul class="nav nav-pills"><li class="nav-item active"><a class="nav-link" title="Latest">WHAT&#8217;S TRENDING</a></li><li class="nav-item"><a class="nav-link">Editors&#039; Picks</a></li></ul>
    <div class="jt-trending"><div class="article"><div class="article-details"><div class="article-title"><a href="/news/2026/10/30/x/" title="t">Renowned Japanese pianist found guilty of driving at 144 kph</a></div></div></div></div>
    </body></html>`;
  const jtText = stripRelatedLinks(htmlToText(jt).text);
  assert.doesNotMatch(jtText, /Politics|More sports|TRENDING|Editors|pianist/);
  assert.match(jtText, /^Taipei – The China Coast Guard/);

  const cbs = `<html><body><article class="content-article">${para(`Trump <a href="/news/x/">pardoned Zhao</a> in 2025. Zhao said user funds were safe.`)}
    <ul><li>Withdrawals stopped on <a href="/news/y/">Thursday</a> night, the exchange said.</li></ul>
    <aside class="component list recirculation"><h3 class="component__title">North Korea <a href="/feature/north-korea-tensions/">More</a></h3>
    <ul><li class="card-recirc item"><a href="/news/treasury-sanctions/" class="item__anchor"><article><h4>Treasury sanctions North Koreans, Russians over IT worker scheme</h4></article></a></li></ul></aside>
    ${para("Binance said on social media it had found no evidence of any wallet private key leak.")}${para(filler).repeat(4)}</article></body></html>`;
  const cbsText = stripRelatedLinks(htmlToText(cbs).text);
  assert.doesNotMatch(cbsText, /Treasury sanctions|North Korea\n|^More$/m);
  assert.match(cbsText, /^Trump pardoned Zhao in 2025\. Zhao said user funds were safe\.\nWithdrawals stopped on Thursday night, the exchange said\.\nBinance said on social media/,
    "aside の後ろの本文まで取り、文の中のリンクと文のある li は残す");
});

test("htmlToText: タグで空いた開きの引用符の直後・閉じの直前の空白を詰める（記者の地の文を発言と読ませない）", () => {
  const html = `<article><p>Russian forces launched 120 drones at Kyiv overnight, the mayor said, adding: “<a href="https://t.me/x">Air defence</a> is working.” He also wrote: “Stay in <b>shelters</b>”, and “ <i>keep calm</i> ”.</p>${"<p>Filler sentence about the response of emergency services in the city.</p>".repeat(4)}</article>`;
  const line = htmlToText(html).text.split("\n")[0];
  assert.equal(line, "Russian forces launched 120 drones at Kyiv overnight, the mayor said, adding: “Air defence is working.” He also wrote: “Stay in shelters”, and “keep calm”.");
});

test("htmlToText: 公開日時は meta → JSON-LD → <time> の順に読む", () => {
  const body = `<article>${"<p>Ukraine launched 505 drones at Russia overnight.</p>".repeat(6)}<time datetime="2026-10-01">old</time></article>`;
  const meta = htmlToText(`<html><head><meta content="2026-11-01T05:30:00+02:00" property="article:published_time"><script type="application/ld+json">{"datePublished":"2026-10-30T00:00:00Z"}</script></head><body>${body}</body></html>`);
  assert.equal(meta.publishedAt, "2026-11-01T03:30:00.000Z");
  const ld = htmlToText(`<html><head><script type="application/ld+json">{"@type":"NewsArticle","datePublished": "2026-10-31T22:00:00Z"}</script></head><body>${body}</body></html>`);
  assert.equal(ld.publishedAt, "2026-10-31T22:00:00.000Z");
  assert.equal(htmlToText(`<html><body>${body}</body></html>`).publishedAt, "2026-10-01T00:00:00.000Z");
});

test("robotsAllows: Claude-User の節（無ければ *）を、最も長く一致した規則で読む", () => {
  const cnn = "User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nUser-agent: Claude-User\nUser-agent: Claude-SearchBot\nDisallow: /\n";
  assert.equal(robotsAllows(cnn, "https://edition.cnn.com/2026/11/01/world/x"), false);
  assert.equal(robotsAllows(cnn, "https://edition.cnn.com/x", "googlebot"), true);
  const star = "User-agent: *\nDisallow: /search\nDisallow: /*?amp$\nAllow: /search/about\n# comment\nSitemap: https://x/s.xml\n";
  assert.equal(robotsAllows(star, "https://www.ukrinform.net/rubric-ato/1-x.html"), true);
  assert.equal(robotsAllows(star, "https://www.ukrinform.net/search?q=1"), false);
  assert.equal(robotsAllows(star, "https://www.ukrinform.net/search/about"), true, "長い Allow が勝つ");
  assert.equal(robotsAllows(star, "https://www.ukrinform.net/news?amp"), false, "* と $");
  assert.equal(robotsAllows(star, "https://www.ukrinform.net/news?amp=1"), true);
  assert.equal(robotsAllows("User-agent: claude-user\nDisallow:\n\nUser-agent: *\nDisallow: /\n", "https://x.test/a"), true, "自分の節があれば * は見ない");
  assert.equal(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a\n", "https://x.test/a"), true, "同じ長さなら Allow");
  assert.equal(robotsAllows("", "https://x.test/a"), true);
});

type FakeHttp = { status?: number; body?: string; type?: string; location?: string } | Error;
function fakeFetch(routes: Record<string, FakeHttp>) {
  const seen: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const r = routes[url] ?? { status: 404, body: "" };
    if (r instanceof Error) throw r;
    const headers = new Headers({ "content-type": r.type ?? "text/html; charset=utf-8", ...(r.location ? { location: r.location } : {}) });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers });
  }) as typeof fetch;
  return { f, seen };
}

test("fetchPageText: robots.txt が Claude-User に許したページだけ取る。読めない robots.txt は断られたものとみなす", async () => {
  const ARTICLE = "https://www.ukrinform.net/rubric-ato/1-x.html";
  const ROBOTS = "https://www.ukrinform.net/robots.txt";
  const html = `<html><head><title>T</title></head><body><article>${"<p>Air defenses shot down 105 drones overnight.</p>".repeat(6)}</article></body></html>`;

  const ok = fakeFetch({ [ROBOTS]: { body: "User-agent: *\nDisallow: /search\n", type: "text/plain" }, [ARTICLE]: { body: html } });
  assert.match((await fetchPageText(ARTICLE, ok.f))!.text, /^Air defenses shot down 105 drones/);
  assert.deepEqual(ok.seen, [ROBOTS, ARTICLE]);

  const no = fakeFetch({ [ROBOTS]: { body: "User-agent: Claude-User\nDisallow: /\n", type: "text/plain" }, [ARTICLE]: { body: html } });
  assert.equal(await fetchPageText(ARTICLE, no.f), null);
  assert.deepEqual(no.seen, [ROBOTS], "断られたページは取りに行かない");

  for (const robots of [{ status: 503, body: "" }, { status: 404, body: "" }, new TypeError("fetch failed")]) {
    const bad = fakeFetch({ [ROBOTS]: robots, [ARTICLE]: { body: html } });
    assert.equal(await fetchPageText(ARTICLE, bad.f), null);
    assert.deepEqual(bad.seen, [ROBOTS]);
  }

  const moved = "https://www.ukrinform.net/private/1-x.html";
  const redirect = fakeFetch({
    [ROBOTS]: { body: "User-agent: *\nDisallow: /private\n", type: "text/plain" },
    [ARTICLE]: { status: 301, location: "/private/1-x.html" },
    [moved]: { body: html },
  });
  assert.equal(await fetchPageText(ARTICLE, redirect.f), null, "転送先も robots で確かめる");
  assert.deepEqual(redirect.seen, [ROBOTS, ARTICLE, ROBOTS]);

  const ABC_GO = "https://abcnews.go.com/International/wireStory/france-heads-weekend-protests-137729925";
  const ABC = "https://abcnews.com/International/wireStory/france-heads-weekend-protests-137729925";
  const abcRobots = { body: "User-agent: anthropic-ai\nDisallow: /\n\nUser-agent: *\nDisallow: /search?searchtext=*\n", type: "text/plain" };
  const abc = fakeFetch({ "https://abcnews.go.com/robots.txt": abcRobots, "https://abcnews.com/robots.txt": abcRobots, [ABC_GO]: { status: 301, location: ABC }, [ABC]: { body: html } });
  assert.match((await fetchPageText(ABC_GO, abc.f))!.text, /^Air defenses shot down 105 drones/, "abcnews.go.com から abcnews.com への転送を追う");
  assert.deepEqual(abc.seen, ["https://abcnews.go.com/robots.txt", ABC_GO, "https://abcnews.com/robots.txt", ABC]);

  const away = fakeFetch({ [ROBOTS]: { body: "", type: "text/plain" }, [ARTICLE]: { status: 302, location: "https://www.reuters.com/x" } });
  assert.equal(await fetchPageText(ARTICLE, away.f), null, "許可した媒体の外へ転送されたら取らない");
  assert.equal(await fetchPageText("https://www.npr.org/2026/10/27/x", fakeFetch({}).f), null, "許可していない媒体は robots.txt も取らない");
});

class FakeDesk implements NewsDeskPort {
  readonly seen: DeskStory[] = [];
  constructor(private readonly reply: (s: DeskStory) => DeskResult | Promise<DeskResult>) {}
  async write(s: DeskStory) {
    this.seen.push(s);
    return this.reply(s);
  }
}

async function tmpScript(stories: unknown[] | null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dw60-explainers-"));
  if (stories) await fs.writeFile(path.join(dir, "script-en.json"), JSON.stringify({ date: "2026-11-01", stories }));
  return dir;
}
const SCRIPT_STORIES = [
  { index: 1, country: { code: "UA", flag: "🇺🇦", name: "Ukraine" }, headline: "h1", summary: "s1", sourceName: "Reuters", sourceUrl: REUTERS, mapMarkers: [{ label: "Ryazan" }, { lon: 1 }] },
  { index: 2, country: { code: "IR", flag: "🇮🇷", name: "Iran" }, headline: "h2", summary: "s2", sourceName: "AP" },
];
const readJson = async (p: string) => JSON.parse(await fs.readFile(p, "utf-8"));

test("write-explainers: EXPLAINER=off は全部 not_assigned、API を呼ばない", async () => {
  const dir = await tmpScript(SCRIPT_STORIES);
  let made = 0;
  const logs: string[] = [];
  await writeExplainers({ date: "2026-11-01", dir, experiments: [], override: "off", apiKey: "k", capUsd: 2, makeDesk: () => { made++; return new FakeDesk(() => { throw new Error("no"); }); }, log: s => logs.push(s) });
  assert.equal(made, 0);
  assert.deepEqual(await readJson(path.join(dir, STATUS_FILE)), { 1: { status: "not_assigned", code: "ua" }, 2: { status: "not_assigned", code: "ir" } });
  assert.deepEqual((await readJson(path.join(dir, USAGE_FILE))).calls, []);
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: 割り付けた本にキーが無ければ disabled と警告", async () => {
  const dir = await tmpScript(SCRIPT_STORIES);
  const logs: string[] = [];
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], override: "on", apiKey: " ", capUsd: 2, makeDesk: () => { throw new Error("no"); }, log: s => logs.push(s) });
  assert.deepEqual(Object.values(res.status).map(s => s.status), ["disabled", "disabled"]);
  assert.ok(logs.some(l => l.startsWith("::warning::")));
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: ok の本だけ台本を書き、前の回の台本は消す", async () => {
  const dir = await tmpScript(SCRIPT_STORIES);
  const stale = path.join(dir, storyboardFile(2, "IR"));
  await fs.writeFile(stale, "{}");
  const board = toStoryboard(goodBoard(), { ...STORY, index: 1 }, new Map()).sb!;
  const fake = new FakeDesk(s => (s.index === 1
    ? { status: "ok", storyboard: board, docs: [], errors: [], costUsd: 0.4 }
    : { status: "check_failed", docs: [], errors: ["l2: 数 490 が引用文に無い"], costUsd: 0.25 }));
  let capSeen = -1;
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], override: "on", apiKey: "k", capUsd: 1.5, storyCapUsd: 0.7, makeDesk: m => { capSeen = m.capUsd; return fake; }, log: () => {} });
  assert.equal(capSeen, 1.5);
  assert.deepEqual(fake.seen.map(s => [s.index, s.countryCode, s.places]), [[1, "UA", ["Ryazan"]], [2, "IR", undefined]]);
  assert.equal(fake.seen[0].sourceUrl, REUTERS);
  assert.deepEqual(await readJson(path.join(dir, storyboardFile(1, "UA"))), board);
  await assert.rejects(fs.stat(stale));
  assert.deepEqual(res.status, {
    1: { status: "ok", code: "ua", costUsd: 0.4 },
    2: { status: "check_failed", code: "ir", errors: ["l2: 数 490 が引用文に無い"], costUsd: 0.25 },
  });
  assert.deepEqual(res.crashed, []);
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: コードの誤りの本は crashed に入れ、呼び出しが返る前でも後でも incomplete（Routine のデータで起きうるので腕に数える）", async () => {
  const dir = await tmpScript(SCRIPT_STORIES);
  const res = await writeExplainers({
    date: "2026-11-01", dir, experiments: [], override: "on", apiKey: "k", capUsd: 4,
    makeDesk: m => new FakeDesk(s => {
      if (s.index === 2) m.record(m.reserve("research", s.index)!, "claude-opus-5-5", { input_tokens: 1000 });
      throw new TypeError("oops");
    }),
    log: () => {},
  });
  assert.equal(res.status["1"].status, "incomplete");
  assert.equal(res.status["2"].status, "incomplete");
  assert.equal(res.status["2"].costUsd, 0.004);
  assert.deepEqual(res.crashed, ["1 ua", "2 ir"]);
  assert.equal((await readJson(path.join(dir, STATUS_FILE)))["1"].status, "incomplete");
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: 本ごとの予算を投稿順に最初に押さえ、押さえられない本は呼ばずに cap", async () => {
  const stories = [3, 1, 2].map(index => ({ index, country: { code: ["UA", "IR", "PL"][index - 1] }, headline: "h", summary: "s", sourceName: "x" }));
  const dir = await tmpScript(stories);
  let meter: CostMeter | undefined;
  const fake = new FakeDesk(s => ({ status: "check_failed", docs: [], errors: ["x"], costUsd: meter!.storyCost(s.index) }));
  const res = await writeExplainers({
    date: "2026-11-01", dir, experiments: [], override: "on", apiKey: "k", capUsd: 2.5, storyCapUsd: 1.2,
    makeDesk: m => { meter = m; return fake; }, log: () => {},
  });
  assert.deepEqual(fake.seen.map(s => s.index).sort(), [1, 2], "投稿順で先の 1・2 に予算が付く（台本の並びではない）");
  assert.deepEqual(res.status["3"], { status: "cap", code: "pl", errors: ["1回の実行の上限 $2.5 に、この本の予算 $1.2 が収まらない（投稿順に押さえる）"] });
  assert.equal(meter!.storyBudget(1), 1.2);
  assert.equal(meter!.storyBudget(3), undefined);
  assert.ok(INFRA_FAILURES.includes("cap"), "呼ぶ前の cap は中身と無関係なので比較から外す");
  assert.equal((await readJson(path.join(dir, USAGE_FILE))).storyCapUsd, 1.2);
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: 採用済み（adopted）の施策も台帳から styleFor に届く", async () => {
  const reg = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../experiments/registry.json"), "utf-8"));
  const exp = reg.experiments.find((e: Experiment) => e.id === "news-explainer-2026-11");
  assert.ok(exp);
  const adopted = { ...exp, status: "adopted", decision: { result: "adopted", action: "全本を解説形式にする", by: "owner", on: "2026-11-26", learning: "x" } };
  const regDir = await fs.mkdtemp(path.join(os.tmpdir(), "dw60-registry-"));
  const file = path.join(regDir, "registry.json");
  await fs.writeFile(file, JSON.stringify({ ...reg, experiments: [adopted] }));
  const experiments = registryExperiments(file);
  assert.deepEqual(experiments.map(e => [e.id, e.status]), [["news-explainer-2026-11", "adopted"]]);

  const dir = await tmpScript(SCRIPT_STORIES);
  const fake = new FakeDesk(() => ({ status: "check_failed", docs: [], errors: ["x"], costUsd: 0 }));
  const res = await writeExplainers({ date: "2026-11-30", dir, experiments, apiKey: "k", capUsd: 4, makeDesk: () => fake, log: () => {} });
  assert.equal(fake.seen.length, 2, "期間の後も全本を解説形式で試みる");
  assert.deepEqual(Object.values(res.status).map(s => s.status), ["check_failed", "check_failed"]);
  await fs.rm(dir, { recursive: true });
  await fs.rm(regDir, { recursive: true });
});

test("write-explainers: script-en.json が無くても空の状態ファイルを書いて終わる", async () => {
  const dir = await tmpScript(null);
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], apiKey: "k", capUsd: 2, makeDesk: () => { throw new Error("no"); }, log: () => {} });
  assert.deepEqual(res.status, {});
  assert.deepEqual(await readJson(path.join(dir, STATUS_FILE)), {});
  assert.equal((await readJson(path.join(dir, USAGE_FILE))).totalUsd, 0);
  await fs.rm(dir, { recursive: true });
});

test("capFromEnv: 既定は $4（本ごとは $1.2）、0 は止める指定として受ける", () => {
  assert.equal(capFromEnv(undefined), 4);
  assert.equal(capFromEnv(""), 4);
  assert.equal(capFromEnv("abc"), 4);
  assert.equal(capFromEnv("-1"), 4);
  assert.equal(capFromEnv("0"), 0);
  assert.equal(capFromEnv("3.5"), 3.5);
  assert.equal(capFromEnv(undefined, DEFAULT_STORY_CAP_USD), 1.2);
  assert.ok(DEFAULT_STORY_CAP_USD >= RESERVE.research + 2 * RESERVE.write + 2 * RESERVE.refute, "直し込みの最後まで見込み額が収まる");
  assert.ok(capFromEnv(undefined) >= 3 * DEFAULT_STORY_CAP_USD, "3本の日も全部に予算が付く");
});
