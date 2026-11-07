import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { alignBeats, type StoryLine, type Word } from "../../domain/storyboard/Storyboard.js";
import { numbersInLabel } from "../build-map-library.js";

/**
 * 地図ショートのナレーション。registry.json の narration（言い回しだけを人が書いた文）に、
 * 画面と同じ件数と、値の最上位・最下位の国名を差し込み、Kokoro で読み上げて文ごとの時刻を返す。
 * 差し込み: {n:<legend key>} = その凡例の件数（MapShort の凡例チップと同じ数）、{top} / {bottom} = raw の最大・最小の国。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE = (process.env.TTS_ENGINE ?? "kokoro").toLowerCase();
const KOKORO_VOICE = process.env.KOKORO_VOICE ?? "am_michael";
const VOICE = process.env.EN_VOICE ?? "en-US-AndrewMultilingualNeural";
const RATE = process.env.TTS_RATE ?? "-5%";

export type RankedCountry = { name: string; ccn3: string };
export type NarrationLine = { text: string; keys: string[]; highlight: string | null };
export type TimedNarrationLine = NarrationLine & { start: number; end: number; words: Word[] };

const SLOT = /\{(n:[^}]+|top|bottom)\}/g;

/**
 * 差し込みを埋める。手で書いた部分の数は、凡例・見出し・CTA・補足に出る数だけ許す（数を作らない）。
 * 知らない差し込み・凡例に無い鍵・数の食い違いは例外にする（本番の地図なので黙って出さない）。
 */
export function fillNarration(
  lines: string[],
  counts: Record<string, number>,
  ranked: RankedCountry[],
  allowedText: string[],
): NarrationLine[] {
  const allowed = allowedText.flatMap(numbersInLabel);
  return lines.map(src => {
    const keys: string[] = [];
    let highlight: string | null = null;
    const literal = src.replace(SLOT, " ");
    const stray = numbersInLabel(literal).filter(n => !allowed.some(a => Math.abs(a - n) <= 1e-9 * Math.max(1, Math.abs(a))));
    if (stray.length) throw new Error(`narration "${src}": number(s) ${stray.join(", ")} are not on the map's legend, title, CTA or note`);
    const text = src.replace(SLOT, (_, slot: string) => {
      if (slot === "top" || slot === "bottom") {
        const c = slot === "top" ? ranked[0] : ranked[ranked.length - 1];
        if (!c) throw new Error(`narration "${src}": {${slot}} needs raw values`);
        highlight = c.ccn3;
        return withArticle(c.name);
      }
      const key = slot.slice(2);
      if (!(key in counts)) throw new Error(`narration "${src}": legend key "${key}" does not exist`);
      keys.push(key);
      return String(counts[key]);
    });
    const leftover = text.match(/\{[^}]*\}?/);
    if (leftover) throw new Error(`narration "${src}": unknown slot ${leftover[0]} (use {n:<legend key>}, {top} or {bottom})`);
    return { text: text.replace(/\s+/g, " ").trim(), keys, highlight };
  });
}

// 英語で the を付けて呼ぶ国名 (countries.json の通称)
const THE_NAMES = new Set([
  "Bahamas", "Central African Republic", "Comoros", "Czechia", "Dominican Republic", "Gambia", "Maldives",
  "Marshall Islands", "Netherlands", "Philippines", "Seychelles", "Solomon Islands",
]);
export const withArticle = (name: string) => (/^United\b/.test(name) || THE_NAMES.has(name) ? `the ${name}` : name);

/** 読み上げた単語を文に割り当てる（解説形式と同じ alignBeats を使う）。 */
export function timeLines(lines: NarrationLine[], words: Word[]): TimedNarrationLine[] {
  const story: StoryLine[] = lines.map((l, i) => ({ id: `n${i + 1}`, kind: "framing", say: l.text, visual: { kind: "counter", value: 0, label: "" } }));
  return alignBeats(story, words).map((b, i) => ({ ...lines[i], start: b.start, end: b.end, words: words.slice(b.from, b.to) }));
}

/** prep-short と同じエンジンの選び方（Kokoro → 失敗時 edge-tts）。単語の時刻を返す。 */
export async function speak(text: string, mp3: string, workDir: string, tag: string): Promise<Word[]> {
  const textFile = path.join(workDir, `_narr-${tag}.txt`);
  const wordsVtt = path.join(workDir, `_narr-${tag}.words.vtt`);
  await fs.writeFile(textFile, text, "utf-8");
  const edge = () => run("python3", [path.join(ROOT, "scripts", "tts-words.py"), VOICE, RATE, textFile, mp3, wordsVtt]);
  try {
    if (ENGINE === "kokoro") {
      await run("python3", [path.join(ROOT, "scripts", "tts-kokoro.py"), KOKORO_VOICE, RATE, textFile, mp3, wordsVtt]).catch(async e => {
        console.warn(`[map-narration] kokoro failed (${e instanceof Error ? e.message : e}) — falling back to edge-tts`);
        await edge();
      });
    } else {
      await edge();
    }
    return expandWords(parseWords(await fs.readFile(wordsVtt, "utf-8")));
  } finally {
    await fs.unlink(textFile).catch(() => {});
    await fs.unlink(wordsVtt).catch(() => {});
  }
}

/** 本編の書き出し (render-shorts.mjs) と同じ -14 LUFS にそろえる。Kokoro の素の音量は約 -27 LUFS で小さすぎる */
export async function normalizeLoudness(mp3: string): Promise<void> {
  const tmp = mp3.replace(/\.mp3$/, ".norm.mp3");
  await run("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "44100", "-codec:a", "libmp3lame", "-q:a", "2", tmp]);
  await fs.rename(tmp, mp3);
}

export function audioDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let o = "";
    p.stdout.on("data", d => (o += d));
    p.on("error", reject);
    p.on("close", c => (c === 0 ? resolve(parseFloat(o.trim())) : reject(new Error(`ffprobe exit ${c}`))));
  });
}

function parseWords(vtt: string): Word[] {
  const out: Word[] = [];
  const lines = vtt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    let w = "";
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) w += lines[j] + " ";
    w = w.trim();
    if (w) out.push({ t, d: Math.max(0.05, e - t), w });
  }
  return out;
}

/** edge-tts が複数語を1キューにまとめた場合に、文字数比で分割する。 */
function expandWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const parts = w.w.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) { out.push(w); continue; }
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    let t = w.t;
    for (const p of parts) {
      const d = (w.d * p.length) / total;
      out.push({ t, d, w: p });
      t += d;
    }
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", c => (c === 0 ? resolve() : reject(new Error(`${cmd} exit ${c}`))));
  });
}
