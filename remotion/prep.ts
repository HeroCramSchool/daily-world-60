import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * Remotion 長尺レンダラーの前処理。
 *
 * 入力:  output/YYYY-MM-DD/longform.json (+ 既存の _lfbg-img-sNN.jpg があれば流用)
 * 出力:  remotion/public/{audio,bg}/*  と  remotion/props.json
 *
 * ナレーションは edge-tts の WordBoundary で単語タイムスタンプを取り、
 * (1) 字幕行  (2) 数値が「読み上げられた瞬間」に出すデータコールアウト
 * の両方をこの段階で確定させる。Remotion 側は props を描くだけにする。
 */

const FPS = 30;
const VOICE = process.env.EN_VOICE ?? "en-US-AndrewMultilingualNeural";
const RATE = process.env.TTS_RATE ?? "-5%";

interface Source { name: string; url: string }
interface Section { heading: string; narration: string; imageQuery?: string; sources?: Source[] }
interface Longform {
  date: string;
  title: string;
  topic: string;
  hook: string;
  sections: Section[];
  todaysWord?: { word: string; definitionEn: string };
}

interface Word { t: number; d: number; w: string }
interface Line { start: number; end: number; text: string }
type CalloutKind = "percent" | "currency" | "delta" | "plain";
interface Callout {
  t: number;
  end: number;
  label: string;
  kind: CalloutKind;
  display: string;
  from?: string;
  value: number;
}
interface Segment {
  kind: "hook" | "section" | "outro";
  index: number;
  heading: string;
  audio: string;
  durationSec: number;
  words: Word[];
  lines: Line[];
  bg: string | null;
  source: Source | null;
  callouts: Callout[];
}

const ROOT = path.resolve(path.join(new URL(".", import.meta.url).pathname, ".."));
const PUB = path.join(ROOT, "remotion", "public");

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join(ROOT, "output", date);
  const lf: Longform = JSON.parse(await fs.readFile(path.join(dir, "longform.json"), "utf-8"));

  await fs.mkdir(path.join(PUB, "audio"), { recursive: true });
  await fs.mkdir(path.join(PUB, "bg"), { recursive: true });

  const plan: { kind: Segment["kind"]; heading: string; text: string; src: Source | null; bgSrc: string | null }[] = [];

  plan.push({
    kind: "hook",
    heading: "Intro",
    text: `${lf.hook} In this deep dive, we break it down step by step.`,
    src: null,
    bgSrc: null,
  });

  lf.sections.forEach((s, i) => {
    const id = `s${String(i + 1).padStart(2, "0")}`;
    plan.push({
      kind: "section",
      heading: s.heading,
      text: s.narration,
      src: s.sources?.[0] ?? null,
      bgSrc: path.join(dir, `_lfbg-img-${id}.jpg`),
    });
  });

  plan.push({
    kind: "outro",
    heading: "Your turn",
    text: `That is the whole picture. If this made the numbers clearer, subscribe — we do one deep dive like this every week. So what do you think about this?`,
    src: null,
    bgSrc: null,
  });

  const segments: Segment[] = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const id = `seg${String(i).padStart(2, "0")}`;
    const mp3Abs = path.join(PUB, "audio", `${id}.mp3`);
    const vttAbs = path.join(PUB, "audio", `${id}.vtt`);
    const txtAbs = path.join(PUB, "audio", `${id}.txt`);

    await fs.writeFile(txtAbs, p.text, "utf-8");
    console.log(`[prep] ${id} (${p.kind}) ${p.text.split(/\s+/).length} words → tts`);
    await run("python3", [path.join(ROOT, "scripts", "tts-words.py"), VOICE, RATE, txtAbs, mp3Abs, vttAbs]);
    await fs.unlink(txtAbs).catch(() => {});

    const words = expandWords(await parseWords(vttAbs));
    const bounds = sentenceBounds(words, p.text);
    const durationSec = await ffprobeDuration(mp3Abs);

    let bg: string | null = null;
    if (p.bgSrc && (await exists(p.bgSrc))) {
      const dest = `bg/${id}.jpg`;
      await fs.copyFile(p.bgSrc, path.join(PUB, dest));
      bg = dest;
    }

    segments.push({
      kind: p.kind,
      index: i,
      heading: p.heading,
      audio: `audio/${id}.mp3`,
      durationSec,
      words,
      lines: groupLines(words, bounds),
      bg,
      source: p.src,
      callouts: findCallouts(words, bounds),
    });
  }

  const bgmSrc = path.join(ROOT, "assets", "news-bed-longform.mp3");
  let bgm: string | null = null;
  let bgmDurationSec = 0;
  if (await exists(bgmSrc)) {
    await fs.copyFile(bgmSrc, path.join(PUB, "bgm.mp3"));
    bgm = "bgm.mp3";
    bgmDurationSec = await ffprobeDuration(bgmSrc);
  }

  const props = {
    date: lf.date ?? date,
    title: lf.title,
    topic: lf.topic,
    fps: FPS,
    bgm,
    bgmDurationSec,
    segments,
  };
  const propsPath = path.join(ROOT, "remotion", "props.json");
  await fs.writeFile(propsPath, JSON.stringify(props, null, 2), "utf-8");

  const total = segments.reduce((a, s) => a + s.durationSec, 0);
  console.log(`[prep] ${segments.length} segments, ${total.toFixed(1)}s total`);
  console.log(`[prep] callouts: ${segments.map(s => s.callouts.length).join("/")}`);
  console.log(`[prep] → ${propsPath}`);
}

/* ---------- captions ---------- */

/** ナレーション原文の文境界を単語インデックスに写す。
 *  edge-tts は句読点を落とすため、正規化文字列の長さで前方一致させる。 */
function sentenceBounds(words: Word[], narration: string): number[] {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentences = narration.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const bounds: number[] = [];
  let wi = 0;
  for (const sentence of sentences) {
    const target = norm(sentence);
    if (!target) continue;
    let acc = "";
    while (wi < words.length && acc.length < target.length) acc += norm(words[wi++].w);
    bounds.push(wi);
  }
  if (bounds[bounds.length - 1] !== words.length) bounds.push(words.length);
  return bounds;
}

const MAX_WORDS = 8;
const MAX_CHARS = 46;

/** 文の内側だけで束ねる字幕行。
 *  貪欲に詰めると "…go up 2.8" / "percent" のような孤立行が出るので、
 *  必要行数を先に決めてから均等割りする。 */
function groupLines(words: Word[], bounds: number[]): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const end of bounds) {
    const sent = words.slice(start, end);
    start = end;
    if (!sent.length) continue;
    const chars = sent.map(w => w.w).join(" ").length;
    const n = Math.max(1, Math.ceil(sent.length / MAX_WORDS), Math.ceil(chars / MAX_CHARS));
    const per = Math.ceil(sent.length / n);
    for (let i = 0; i < sent.length; i += per) {
      const chunk = sent.slice(i, i + per);
      const last = chunk[chunk.length - 1];
      lines.push({ start: chunk[0].t, end: last.t + last.d, text: chunk.map(w => w.w).join(" ") });
    }
  }
  return lines;
}

/* ---------- data callouts ---------- */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9.\-]/g, "");

function isNumWord(raw: string): boolean {
  const s = clean(raw);
  if (!s) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return true;
  return s.split("-").every(p => p in UNITS || p in TENS || p in SCALES);
}

/** 連続する数値語を実数に変換する ("two hundred two" -> 202, "2.8" -> 2.8)。 */
function wordsToNumber(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const raw of tokens) {
    for (const part of clean(raw).split("-")) {
      if (!part) continue;
      if (/^\d+(\.\d+)?$/.test(part)) { current += parseFloat(part); seen = true; continue; }
      if (part in UNITS) { current += UNITS[part]; seen = true; continue; }
      if (part in TENS) { current += TENS[part]; seen = true; continue; }
      if (part === "hundred") { current = (current || 1) * 100; seen = true; continue; }
      if (part in SCALES) { total += (current || 1) * SCALES[part]; current = 0; seen = true; continue; }
      return null;
    }
  }
  return seen ? total + current : null;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(n < 10 ? 1 : 2));
const fmtMoney = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2)}`;

/**
 * 読み上げ順に走査して「数字＋単位」を拾い、その語が発話された時刻をコールアウト時刻にする。
 * 直前に from-to 構文 ("from A to B") があれば before/after の比較カードにする。
 */
function findCallouts(words: Word[], bounds: number[]): Callout[] {
  const out: Callout[] = [];
  /** その数値を含む文の、数値直前までの語 (最大5語) をそのままラベルにする。
   *  言い換えず原文のまま使うので、数字の意味づけを取り違えることがない。 */
  const UNIT = /^(percent|percentage|dollar|dollars|cent|cents)$/i;
  const STOP = new Set("a an the this that these those it its is are was were be been of and or but so to at in on for from with we you your our i".split(" "));
  const sentStartOf = (idx: number) => {
    let st = 0;
    for (const b of bounds) { if (idx < b) break; st = b; }
    return st;
  };
  const finish = (kept: string[]) =>
    kept.length >= 2 && kept.some(w => !STOP.has(clean(w))) ? kept.join(" ") : "";

  /** 数値の直前の語を最大5語、原文のまま。数値語と単位語は飛ばす。 */
  const labelFor = (start: number): string => {
    const sentStart = sentStartOf(start);
    const kept: string[] = [];
    for (let i = start - 1; i >= sentStart && kept.length < 5; i--) {
      const w = words[i].w;
      if (isNumWord(w) || UNIT.test(clean(w))) continue;
      kept.unshift(w);
    }
    return finish(kept);
  };

  /** from→to の比較は「何が変わったか」が主語にあるので、文頭側から拾う。 */
  const subjectFor = (start: number): string => {
    const sentStart = sentStartOf(start);
    const kept: string[] = [];
    for (let i = sentStart; i < start && kept.length < 6; i++) {
      const w = words[i].w;
      if (isNumWord(w) || UNIT.test(clean(w))) continue;
      kept.push(w);
    }
    return finish(kept);
  };
  let i = 0;
  let pendingFrom: { value: number; kind: CalloutKind; startIdx: number } | null = null;

  while (i < words.length) {
    if (!isNumWord(words[i].w)) {
      if (clean(words[i].w) === "from") pendingFrom = null;
      i++;
      continue;
    }
    const start = i;
    const toks: string[] = [];
    while (i < words.length && isNumWord(words[i].w)) { toks.push(words[i].w); i++; }
    let value = wordsToNumber(toks);
    if (value === null) continue;

    // "and ninety cents" のような端数を吸収する
    let kind: CalloutKind = "plain";
    let unitEnd = i;
    const next = (k: number) => clean(words[k]?.w ?? "");

    if (/^percent/.test(next(i))) { kind = "percent"; unitEnd = i + 1; }
    else if (/^(dollar|dollars)$/.test(next(i))) {
      kind = "currency";
      unitEnd = i + 1;
      if (next(i + 1) === "and") {
        let j = i + 2;
        const centToks: string[] = [];
        while (j < words.length && isNumWord(words[j].w)) { centToks.push(words[j].w); j++; }
        if (/^cents?$/.test(next(j)) && centToks.length) {
          const c = wordsToNumber(centToks);
          if (c !== null) { value += c / 100; unitEnd = j + 1; }
        }
      }
    }
    if (kind === "plain") continue;

    const prev = clean(words[start - 1]?.w ?? "");
    const display = kind === "percent" ? `${fmtNum(value)}%` : fmtMoney(value);

    if (prev === "from") {
      pendingFrom = { value, kind, startIdx: start };
      i = unitEnd;
      continue;
    }
    if (prev === "to" && pendingFrom && pendingFrom.kind === kind) {
      out.push({
        t: words[start].t,
        end: words[unitEnd - 1].t + words[unitEnd - 1].d,
        label: subjectFor(pendingFrom.startIdx),
        kind: "delta",
        display,
        from: pendingFrom.kind === "percent" ? `${fmtNum(pendingFrom.value)}%` : fmtMoney(pendingFrom.value),
        value,
      });
      pendingFrom = null;
      i = unitEnd;
      continue;
    }

    out.push({ t: words[start].t, end: words[unitEnd - 1].t + words[unitEnd - 1].d, label: labelFor(start), kind, display, value });
    i = unitEnd;
  }

  // 近すぎるコールアウトは後勝ちで間引く (画面が渋滞する)
  const MIN_GAP = 2.2;
  const kept: Callout[] = [];
  for (const c of out) {
    if (kept.length && c.t - kept[kept.length - 1].t < MIN_GAP) {
      if (c.kind === "delta") kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }
  return kept;
}

/* ---------- io ---------- */

async function parseWords(p: string): Promise<Word[]> {
  const text = await fs.readFile(p, "utf-8");
  const lines = text.split(/\r?\n/);
  const out: Word[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    const w = (lines[i + 1] ?? "").trim();
    if (w) out.push({ t: +start.toFixed(3), d: +(end - start).toFixed(3), w });
  }
  return out;
}

/** edge-tts は "2.8 percent" のように複数語を1キューで返すことがある。
 *  文字数比で時間を按分して1語1キューに展開する (数値+単位の検出と字幕の粒度のため)。 */
function expandWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const c of words) {
    const parts = c.w.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) { out.push(c); continue; }
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    let acc = 0;
    for (const part of parts) {
      const d = (c.d * part.length) / total;
      out.push({ t: +(c.t + acc).toFixed(3), d: +d.toFixed(3), w: part });
      acc += d;
    }
  }
  return out;
}

function exists(p: string) { return fs.access(p).then(() => true).catch(() => false); }

function ffprobeDuration(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]);
    let buf = "";
    proc.stdout.on("data", d => (buf += d));
    proc.on("error", reject);
    proc.on("close", c => (c === 0 ? resolve(+parseFloat(buf.trim()).toFixed(3)) : reject(new Error(`ffprobe exit ${c}`))));
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", c => (c === 0 ? resolve() : reject(new Error(`${cmd} exit ${c}`))));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
