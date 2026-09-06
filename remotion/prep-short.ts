import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { laneFromStory, mapSceneParts } from "../scripts/lib/mapscene.js";
import { recordBgmUsed } from "../scripts/lib/bgm-credit.js";
import { pickBgm, isConflictStory } from "../scripts/lib/bgm-select.js";

/**
 * 日次ショート (9:16) の props を作る。
 *
 * 入力:  output/YYYY-MM-DD/script-en.json, voice-{code}.vtt, _assets/
 * 出力:  remotion/props-short.json, remotion/public/short/*
 *
 * ナレーションは既存 vtt の文を連結して edge-tts で作り直す。単語タイムスタンプが
 * 取れるので、カラオケ字幕を「表示語 = 発話語」で厳密に一致させられる
 * (build-news-video.ts の resampleDurs による近似が不要になる)。
 */

const FPS = 30;
// 本番のショート (tts-per-story.ts) と同じ既定: Kokoro-82M (Apache-2.0・自前実行)。
// edge-tts より自然で、非公式エンドポイント依存も無い。失敗時は edge-tts へ降格する。
const ENGINE = (process.env.TTS_ENGINE ?? "kokoro").toLowerCase();
const KOKORO_VOICE = process.env.KOKORO_VOICE ?? "am_michael";
const VOICE = process.env.EN_VOICE ?? "en-US-AndrewMultilingualNeural";
const RATE = process.env.TTS_RATE ?? "-5%";

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

const MAX_SCENE_SEC = Number(process.env.MAX_SCENE_SEC ?? "5");
const MAX_WORDS_PER_CHUNK = Number(process.env.MAX_WORDS_PER_CHUNK ?? "5");
const MIN_CHUNK_SEC = Number(process.env.MIN_CHUNK_SEC ?? "1.3");
const BODY_BG = 7;
// 1枚の写真を映す最短秒数。これを超えたら次の写真へ送る。
// 従来は「文ごとに1枚」で47秒に4-5枚しか出ず、静止して見えた (2026-08-30 オーナー指摘)。
const MIN_PHOTO_SEC = Number(process.env.MIN_PHOTO_SEC ?? "2.0");
const BGM_VOLUME = process.env.BGM_VOLUME ?? "0.25";
// 戦争・紛争系のニュースでは、明るい報道ベッドではなく元の news-bed に戻す (オーナー指示 2026-09-02)。
const BGM_CONFLICT_PATH = process.env.BGM_CONFLICT_PATH ?? "";

const ACCENTS = ["#F5E63B", "#FFB347", "#5EEAD4"];
const accentFor = (i: number) => ACCENTS[(i - 1) % ACCENTS.length] ?? ACCENTS[0];

interface Story {
  index: number;
  country: { code: string; flag: string; name?: string };
  headline: string;
  hookText?: string;
  summary: string;
  sourceName: string;
  sourceUrl?: string;
  commentQuestion?: string;
}
interface ScriptJson { date: string; stories: Story[] }

interface Word { t: number; d: number; w: string }
interface Cue { start: number; end: number; text: string }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const repo = ROOT;
  const dir = process.env.OUT_DIR ?? path.join(repo, "output", date);
  const pub = path.join(HERE, "public", "short");
  await fs.mkdir(pub, { recursive: true });

  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const only = process.env.ONLY_CODE?.toLowerCase();
  const stories = only ? script.stories.filter(s => s.country.code.toLowerCase() === only) : script.stories;

  const out: unknown[] = [];
  for (const story of stories) out.push(await buildStory(dir, pub, story, date));

  const props = { date, fps: FPS, videos: out };
  await fs.writeFile(path.join(HERE, "props-short.json"), JSON.stringify(props, null, 2));
  // Root.tsx は長尺の props.json も静的 import する。ショートだけ回す場合に備えて雛形を置く。
  const lf = path.join(HERE, "props.json");
  if (!(await exists(lf))) {
    await fs.writeFile(lf, JSON.stringify({ date, title: "", topic: "", fps: FPS, segments: [] }, null, 2));
  }
  console.log(`[prep-short] ${out.length} video(s) → props-short.json`);
}

async function buildStory(dir: string, pub: string, story: Story, date: string) {
  const code = story.country.code.toLowerCase();
  const accent = accentFor(story.index);

  // 既存の文字幕から原稿を復元する (公開済みの原稿と同一)。
  const srcCues = await parseVtt(path.join(dir, `voice-${code}.vtt`));
  const narration = srcCues.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();

  const mp3 = path.join(pub, `voice-${code}.mp3`);
  const wordsVtt = path.join(dir, `_rs-${code}.words.vtt`);
  const textFile = path.join(dir, `_rs-${code}.txt`);
  await fs.writeFile(textFile, narration, "utf-8");
  const edge = () => run("python3", [path.join(ROOT, "scripts", "tts-words.py"), VOICE, RATE, textFile, mp3, wordsVtt]);
  try {
    if (ENGINE === "kokoro") {
      await run("python3", [path.join(ROOT, "scripts", "tts-kokoro.py"), KOKORO_VOICE, RATE, textFile, mp3, wordsVtt]);
    } else {
      await edge();
    }
  } catch (e) {
    if (ENGINE !== "kokoro") throw e;
    console.warn(`[prep-short] ${code}: kokoro failed (${e instanceof Error ? e.message : e}) — falling back to edge-tts`);
    await edge();
  } finally {
    await fs.unlink(textFile).catch(() => {});
  }

  const words = expandWords(await parseWords(wordsVtt));
  await fs.unlink(wordsVtt).catch(() => {});
  const duration = await ffprobeDuration(mp3);

  // 文境界 = 単語列上のインデックス。以降のカット割りは全部この上で決める。
  const bounds = sentenceBounds(words, narration);
  const sentences: Cue[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b <= a) continue;
    sentences.push({
      start: words[a].t,
      end: words[b - 1].t + words[b - 1].d,
      text: words.slice(a, b).map(w => w.w).join(" "),
    });
  }

  const countryIdx = sentences.findIndex(c => /here's what's happening|comes from|news from/i.test(c.text));
  const outroIdx = sentences.findIndex(c => /that's the latest|thanks for watching|subscribe/i.test(c.text));
  const qIdx = sentences.findIndex(c => /what do you think about this/i.test(c.text));

  const hookEnd = countryIdx >= 0 ? sentences[countryIdx].end : Math.min(4, duration);
  const bodyStart = countryIdx + 1;
  const bodyEnd = qIdx >= 0 ? qIdx : outroIdx >= 0 ? outroIdx : sentences.length;

  const assets = await fs.readdir(path.join(dir, "_assets")).catch(() => [] as string[]);
  const beats = assets.filter(f => new RegExp(`^beat-${code}-s${story.index}-b\\d+\\.jpg$`).test(f)).sort();
  // fetch-photos.ts が集めた実写プール (public/short に直接置かれる)。
  const pubFiles = await fs.readdir(pub).catch(() => [] as string[]);
  const photos = pubFiles.filter(f => new RegExp(`^photo-${code}-\\d+\\.jpg$`).test(f)).sort();
  const stock = assets.filter(f => new RegExp(`^bg-${code}(-s${story.index})?-\\d+\\.jpg$`).test(f)).sort();
  const flag = assets.find(f => f === `${code}.png`) ?? null;

  const copied = new Set<string>();
  const copy = async (f: string | null) => {
    if (!f) return null;
    if (!copied.has(f)) {
      await fs.copyFile(path.join(dir, "_assets", f), path.join(pub, f));
      copied.add(f);
    }
    return `short/${f}`;
  };

  const pubForHook = await fs.readdir(pub).catch(() => [] as string[]);
  const hookPhoto = pubForHook.filter(f => new RegExp(`^photo-${code}-\\d+\\.jpg$`).test(f)).sort()[0];
  const hookBg = hookPhoto ? `short/${hookPhoto}` : await copy(beats[0] ?? stock[0] ?? null);

  // 地図シーン: 背景 (紺地/グリッド/陸ドット/バッジ) だけ PNG に焼き、マーカーは Remotion 側で動かす。
  // 本番と同じハイブリッド方針で、本文の最初の 1 シーンにだけ出す。
  let map: { bg: string; markers: unknown[] } | null = null;
  const lane = laneFromStory(story);
  if (lane) {
    const parts = mapSceneParts(lane, accent);
    const svgPath = path.join(dir, `_rs-map-${code}.svg`);
    const png = `map-${code}.png`;
    await fs.writeFile(svgPath, parts.baseSvg, "utf-8");
    await run("rsvg-convert", ["-w", "1080", "-h", "1920", svgPath, "-o", path.join(pub, png)]);
    await fs.unlink(svgPath).catch(() => {});
    map = { bg: `short/${png}`, markers: parts.markers };
    console.log(`[prep-short] ${code}: map scene (${parts.markers.length} markers)`);
  }

  // 本文: 3-6 語のチャンクへ割り、写真は MIN_PHOTO_SEC ごとに送る。
  const chunks: Array<Record<string, unknown>> = [];
  let photoIdx = 0;
  let photoSince = -Infinity;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const s = sentences[i];
    if (!s) continue;
    const a = bounds[i], b = bounds[i + 1];
    const cueWords = words.slice(a, b);
    const dur = s.end - s.start;
    const want = Math.max(1, Math.ceil(dur / MAX_SCENE_SEC), Math.ceil(cueWords.length / MAX_WORDS_PER_CHUNK));
    const parts = Math.max(1, Math.min(want, Math.floor(dur / MIN_CHUNK_SEC) || 1));

    const bi = i - bodyStart;
    const beat = beats.length ? beats[Math.min(bi, beats.length - 1)] : null;
    const bgFile = beat ?? (stock.length ? stock[(bi % Math.max(1, Math.min(BODY_BG, stock.length - 1))) + 1] ?? stock[0] : null);
    const bg = await copy(bgFile);
    const motionSrc = beat ? beat.replace(/\.jpg$/, ".motion.mp4") : null;
    const motion = motionSrc && assets.includes(motionSrc) ? await copy(motionSrc) : null;

    const cuts = chunkCuts(cueWords.map(w => w.w), parts);
    for (let k = 0; k < cuts.length - 1; k++) {
      const slice = cueWords.slice(cuts[k], cuts[k + 1]);
      if (!slice.length) continue;
      const t0 = slice[0].t;
      let shot = bg;
      let changed = k === 0;
      if (photos.length) {
        if (t0 - photoSince >= MIN_PHOTO_SEC) {
          photoSince = t0;
          photoIdx++;
          changed = true;
        }
        shot = `short/${photos[(photoIdx - 1 + photos.length) % photos.length]}`;
      }
      chunks.push({
        text: slice.map(w => w.w).join(" "),
        start: t0,
        end: slice[slice.length - 1].t + slice[slice.length - 1].d,
        words: slice.map(w => ({ w: w.w, t: w.t, d: w.d })),
        bg: shot, motion,
        firstOfCue: changed,
      });
    }
  }

  const picked = await pickBgm(date, code, story.index, isConflictStory(story));
  const bgm = picked ? { ...picked, volume: Number(BGM_VOLUME) } : null;
  // 投稿側が概要欄に CC BY 帰属を出せるよう、使った曲を出力ディレクトリに記録する
  // (ffmpeg 経路の build-news-video.ts と同じファイル)。
  if (bgm) await recordBgmUsed(dir, code, bgm.file);

  const tail = (idx: number) => idx >= 0 ? { text: sentences[idx].text, start: sentences[idx].start, end: sentences[idx].end } : null;

  return {
    code, index: story.index, accent,
    country: { name: (story.country.name ?? story.country.code).toUpperCase(), flag: await copy(flag) },
    headline: story.headline,
    hookText: (story.hookText?.trim() || story.headline).toUpperCase(),
    isShortHook: Boolean(story.hookText?.trim()),
    source: { name: story.sourceName, url: shortUrl(story.sourceUrl ?? "") },
    audio: `short/voice-${code}.mp3`,
    bgm,
    duration: duration + 0.4,
    hookEnd, hookBg, map,
    chunks,
    question: qIdx >= 0 ? tail(qIdx) : null,
    outro: tail(outroIdx),
    date,
  };
}

/** 冠詞・前置詞・接続詞。チャンクの末尾に来ると次の語と切り離されて読みにくい。 */
const STICKY = new Set([
  "a","an","the","of","in","on","at","to","for","and","or","but","from","with","by","as",
  "that","its","his","her","their","our","your","into","over","under","after","before",
  "is","are","was","were","has","have","had","will","would","can","could",
]);

/** 語列を parts 個に割る。均等割りを基準に、区切りが STICKY 語の直後に来ないよう ±2 語ずらす。 */
function chunkCuts(words: string[], parts: number): number[] {
  const n = words.length;
  const cuts = [0];
  for (let k = 1; k < parts; k++) {
    const ideal = Math.round((n * k) / parts);
    let best = ideal;
    let bestCost = Infinity;
    for (let d = -2; d <= 2; d++) {
      const c = ideal + d;
      if (c <= cuts[cuts.length - 1] || c >= n) continue;
      const prev = words[c - 1].toLowerCase().replace(/[^a-z']/g, "");
      // 直前が STICKY なら重く罰する。文末記号の直後は歓迎する。
      let cost = Math.abs(d);
      if (STICKY.has(prev)) cost += 10;
      // 固有名詞の連なり (United States / Bath Iron Works) を割らない
      if (/^[A-Z]/.test(words[c - 1]) && /^[A-Z]/.test(words[c])) cost += 8;
      if (/[,.;:!?]$/.test(words[c - 1])) cost -= 3;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    cuts.push(best);
  }
  cuts.push(n);
  return cuts.filter((c, i, a) => i === 0 || c > a[i - 1]);
}





function exists(p: string) { return fs.access(p).then(() => true).catch(() => false); }

function shortUrl(url: string, maxLen = 56): string {
  if (!url) return "";
  const u = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return u.length <= maxLen ? u : u.slice(0, maxLen - 1) + "…";
}

/** 単語列を原稿の文へ整列し、各文の開始インデックスを返す (末尾に総数)。 */
function sentenceBounds(words: Word[], narration: string): number[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentences = narration.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const bounds: number[] = [0];
  let wi = 0;
  for (const sentence of sentences) {
    const target = norm(sentence);
    if (!target) continue;
    let acc = "";
    while (wi < words.length && acc.length < target.length) acc += norm(words[wi++].w);
    bounds.push(wi);
  }
  if (bounds[bounds.length - 1] !== words.length) bounds[bounds.length - 1] = words.length;
  return bounds;
}

async function parseWords(p: string): Promise<Word[]> {
  const text = await fs.readFile(p, "utf-8").catch(() => "");
  const out: Word[] = [];
  const lines = text.split(/\r?\n/);
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

async function parseVtt(p: string): Promise<Cue[]> {
  const text = await fs.readFile(p, "utf-8").catch(() => "");
  const cues: Cue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    let txt = "";
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) txt += lines[j] + " ";
    cues.push({
      start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
      end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
      text: txt.trim(),
    });
  }
  return cues;
}

function ffprobeDuration(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]);
    let o = "";
    proc.stdout.on("data", d => (o += d));
    proc.on("close", c => (c === 0 ? resolve(parseFloat(o.trim())) : reject(new Error(`ffprobe exit ${c}`))));
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
