import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { NewsDesk, extractDocs, extractPublishedHints, htmlToText, toStoryboard, type DeskClient, type HttpPage } from "./NewsDesk.js";
import { CostMeter, costOf, RESERVE } from "./CostMeter.js";
import { OUTLETS, isAllowedUrl } from "./outlets.js";
import type { DeskResult, DeskStory, NewsDeskPort } from "../../application/ports/NewsDeskPort.js";
import { STATUS_FILE, storyboardFile } from "../../domain/storyboard/ExplainerArm.js";
import { writeExplainers, capFromEnv, USAGE_FILE } from "../../scripts/write-explainers.js";

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
const src = (url: string, quote: string, outlet = url === KYIV ? "Kyiv Independent" : "Reuters") => ({ outlet, url, quote });

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

type Canned = Msg | Error;
class FakeClient implements DeskClient {
  readonly bodies: Body[] = [];
  readonly timeouts: Array<number | undefined> = [];
  constructor(private readonly script: Canned[]) {}
  beta = {
    messages: {
      stream: (body: Body, options?: { timeout?: number }) => {
        this.bodies.push(structuredClone(body));
        this.timeouts.push(options?.timeout);
        const next = this.script.shift();
        return {
          finalMessage: async (): Promise<Msg> => {
            if (!next) throw new Error("canned responses ran out");
            if (next instanceof Error) throw next;
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

const PROMPTS = { research: "RESEARCH", writer: "WRITER", refute: "REFUTE" };
function desk(script: Canned[], o: { cap?: number; httpGet?: (url: string) => Promise<HttpPage | null> } = {}) {
  const client = new FakeClient(script);
  const meter = new CostMeter(o.cap ?? 10);
  const httpCalls: string[] = [];
  const d = new NewsDesk({
    client,
    meter,
    now: () => NOW,
    prompts: PROMPTS,
    httpGet: async url => { httpCalls.push(url); return o.httpGet ? o.httpGet(url) : null; },
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

test("extractPublishedHints: 年の書いてある page_age だけを ISO にする", () => {
  const hints = extractPublishedHints(researchPaused().content);
  assert.equal(hints.size, 1);
  assert.equal(new Date(hints.get("aljazeera.com/news/2026/11/1/ukraine-launches-505-drones-at-russia")!).getUTCFullYear(), 2026);
  const iso = extractPublishedHints([searchResult("s", [{ url: KYIV, title: "x", page_age: "2026-10-31" }])]);
  assert.equal(iso.get("kyivindependent.com/ukraine-drone-strike-refineries"), "2026-10-31T00:00:00.000Z");
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
  assert.ok(sb.lines[0].source?.publishedAt, "公開日時は検索結果の page_age から入れる");
  assert.equal(sb.lines[4].source?.publishedAt, undefined);
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
  assert.match(userText(w, 0), /<page id="1" url="https:\/\/www\.aljazeera\.com/);
  assert.match(userText(w, 0), /Research notes:\nI'll look for reports/);

  assert.equal(f.system, "REFUTE");
  assert.equal(f.output_config?.effort, "high");
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

test("API の誤り: SDK の例外は api_error、押さえた見込み額は戻す", async () => {
  const rate = Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }, "Rate limited", new Headers());
  for (const err of [new Anthropic.APIConnectionError({ message: "socket hang up" }), rate]) {
    const { d, meter } = desk([err]);
    const r = await d.write(STORY);
    assert.equal(r.status, "api_error");
    assert.match(r.errors[0], /^research: /);
    assert.equal(meter.spent, 0);
    assert.ok(meter.reserve("research"), "失敗した呼び出しの見込み額が残っていない");
  }
});

test("API の誤り: 書く段の途中でも api_error で止まる", async () => {
  const { d } = desk([researchPaused(), researchDone(), new Anthropic.APIConnectionError({ message: "reset" })]);
  const r = await d.write(STORY);
  assert.equal(r.status, "api_error");
  assert.match(r.errors[0], /^write: /);
  assert.equal(r.docs.length, 2);
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

test("上限: 書く段で上限に届けば cap", async () => {
  // 0.024（1回目）+ 1.94（2回目）+ 書く段の見込み 0.15 > 2
  const heavy = message(researchDone().content, { usage: { input_tokens: 480_000, output_tokens: 1000 } });
  const { d, client } = desk([researchPaused(), heavy], { cap: 2 });
  const r = await d.write(STORY);
  assert.equal(r.status, "cap");
  assert.match(r.errors[0], /^write: /);
  assert.equal(client.bodies.length, 2);
});

test("max_tokens で切れたら api_error", async () => {
  const { d } = desk([message([text("EVENT")], { stop_reason: "max_tokens" })]);
  const r = await d.write(STORY);
  assert.equal(r.status, "api_error");
  assert.match(r.errors[0], /max_tokens/);
});

test("pause_turn が 4 回の続きでも終わらなければ api_error", async () => {
  const paused = () => message([text("...")], { stop_reason: "pause_turn" });
  const { d, client } = desk([paused(), paused(), paused(), paused(), paused(), researchDone()]);
  const r = await d.write(STORY);
  assert.equal(r.status, "api_error");
  assert.equal(client.bodies.length, 5);
  assert.equal(client.bodies[4].messages.length, 2, "続きは assistant を1つにまとめて送る");
});

test("no_docs: 許可した媒体のページが取れなければ no_docs", async () => {
  const empty = message([toolUse("srvtoolu_9", "web_fetch", { url: REUTERS }), fetchError("srvtoolu_9", "url_not_allowed"), text("NO PAGES")]);
  const { d, httpCalls } = desk([empty]);
  const r = await d.write(STORY);
  assert.equal(r.status, "no_docs");
  assert.deepEqual(httpCalls, [REUTERS], "web_fetch で取れなかった出典はコードで取りに行く");
});

test("Routine の出典を web_fetch で取れなければ HTTP で取った本文を使う", async () => {
  const onlyKyiv = message([
    toolUse("srvtoolu_1", "web_fetch", { url: REUTERS }), fetchError("srvtoolu_1", "url_not_accessible"),
    toolUse("srvtoolu_2", "web_fetch", { url: KYIV }), fetchText("srvtoolu_2", KYIV, KYIV_TEXT, null), text("notes"),
  ]);
  const { d, client } = desk([onlyKyiv, writeReply(goodBoard()), refuteReply(true)], { httpGet: async () => ({ title: "Al Jazeera", text: `${REUTERS_TEXT}\n${"More text. ".repeat(20)}` }) });
  const r = await d.write(STORY);
  assert.equal(r.status, "ok", r.errors.join("\n"));
  const http = r.docs.find(x => x.via === "http")!;
  assert.equal(http.url, REUTERS);
  assert.equal(http.retrievedAt, NOW.toISOString());
  assert.match(userText(client.bodies[1], 0), /<page id="2" url="https:\/\/www\.aljazeera\.com[^>]*title="Al Jazeera">/);
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

test("CostMeter: 押さえ中の見込み額も上限に数える（同時に走る本で上限を超えない）", () => {
  const m = new CostMeter(1.0);
  const a = m.reserve("research")!;
  const b = m.reserve("research")!;
  assert.ok(a && b);
  assert.equal(m.reserve("write"), null);
  m.release(b);
  m.release(b);
  const c = m.reserve("write")!;
  assert.ok(c);
  const cost = m.record(a, 1, "claude-opus-5-5", { input_tokens: 25_000, output_tokens: 0 });
  assert.ok(Math.abs(cost - 0.1) < 1e-12);
  assert.ok(m.reserve("research"), "実額 0.1 + 押さえ 0.15 + 0.5 <= 1.0");
  assert.deepEqual(m.calls().map(x => [x.story, x.step]), [[1, "research"]]);
  assert.ok(Math.abs(m.storyCost(1) - 0.1) < 1e-12);
  assert.equal(m.storyCost(2), 0);
});

test("outlets: 国営の宣伝媒体を入れない・サブドメインまで許す", () => {
  for (const bad of ["tass.ru", "tass.com", "xinhuanet.com", "presstv.ir", "rt.com", "globaltimes.cn", "kcna.kp"]) {
    assert.equal(OUTLETS.includes(bad), false, bad);
    assert.equal(isAllowedUrl(`https://${bad}/news/1`), false, bad);
  }
  for (const blocked of ["apnews.com", "reuters.com", "bbc.com", "bbc.co.uk", "theguardian.com", "nytimes.com", "news.sky.com"]) {
    assert.equal(OUTLETS.includes(blocked), false, `${blocked} は Anthropic のクローラーを断っている`);
  }
  assert.equal(isAllowedUrl("https://www.ukrinform.net/rubric-ato/1-x.html"), true);
  assert.equal(isAllowedUrl("https://www.reuters.com/world/x"), false);
  assert.equal(isAllowedUrl("https://edition.cnn.com/2026/11/01/x"), true);
  assert.equal(isAllowedUrl("https://english.aljazeera.com/x"), true);
  assert.equal(isAllowedUrl("https://notukrinform.net/x"), false);
  assert.equal(isAllowedUrl("ftp://ukrinform.net/x"), false);
  assert.equal(new Set(OUTLETS).size, OUTLETS.length);
});

test("htmlToText: タグと実体参照を落とし、<article> があればその中だけ", () => {
  const html = `<html><head><title>Drones &amp; refineries</title><script>var x = "<p>no</p>";</script></head><body>
    <nav>Menu Home</nav><article><h1>Headline</h1><p>Ukraine launched 505&nbsp;drones at Russia&#8217;s regions.</p>
    <p>Second &#x201C;para&#x201D;.</p>${"<p>filler sentence here.</p>".repeat(30)}</article></body></html>`;
  const page = htmlToText(html);
  assert.equal(page.title, "Drones & refineries");
  assert.match(page.text, /^Headline\nUkraine launched 505 drones at Russia’s regions\.\nSecond “para”\./);
  assert.doesNotMatch(page.text, /Menu|no<\/p>|var x/);
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
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], override: "on", apiKey: "k", capUsd: 1.5, makeDesk: m => { capSeen = m.capUsd; return fake; }, log: () => {} });
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

test("write-explainers: コードの誤りの本は api_error と記録し crashed に入れる", async () => {
  const dir = await tmpScript(SCRIPT_STORIES.slice(0, 1));
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], override: "on", apiKey: "k", capUsd: 2, makeDesk: () => new FakeDesk(() => { throw new TypeError("oops"); }), log: () => {} });
  assert.equal(res.status["1"].status, "api_error");
  assert.deepEqual(res.crashed, ["1 ua"]);
  assert.equal((await readJson(path.join(dir, STATUS_FILE)))["1"].status, "api_error");
  await fs.rm(dir, { recursive: true });
});

test("write-explainers: script-en.json が無くても空の状態ファイルを書いて終わる", async () => {
  const dir = await tmpScript(null);
  const res = await writeExplainers({ date: "2026-11-01", dir, experiments: [], apiKey: "k", capUsd: 2, makeDesk: () => { throw new Error("no"); }, log: () => {} });
  assert.deepEqual(res.status, {});
  assert.deepEqual(await readJson(path.join(dir, STATUS_FILE)), {});
  assert.equal((await readJson(path.join(dir, USAGE_FILE))).totalUsd, 0);
  await fs.rm(dir, { recursive: true });
});

test("capFromEnv: 既定は $2、0 は止める指定として受ける", () => {
  assert.equal(capFromEnv(undefined), 2);
  assert.equal(capFromEnv(""), 2);
  assert.equal(capFromEnv("abc"), 2);
  assert.equal(capFromEnv("-1"), 2);
  assert.equal(capFromEnv("0"), 0);
  assert.equal(capFromEnv("3.5"), 3.5);
});
