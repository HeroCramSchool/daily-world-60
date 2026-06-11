import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { fitSingleLine, fitTextBox } from "./lib/textfit.js";

/**
 * Weekly long-form deep-dive renderer (horizontal 1920x1080, 8-12 min).
 *
 * 入力:  output/YYYY-MM-DD/longform.json  (weekly Routine が生成)
 * 出力:  output/YYYY-MM-DD/longform.mp4
 *
 * 構造: 各セグメント(intro / section x N / outro)を
 *   TTS -> VTT -> cue ごとにシーン化 -> 連結 -> 音声 mux して segment.mp4。
 *   全セグメントを連結 -> BGM を低音量ミックス -> longform.mp4。
 *
 * 日次の縦ショート(build-news-video.ts)とは別経路。干渉しない。
 */

const W = 1920;
const H = 1080;
const FPS = 30;
const VOICE = process.env.EN_VOICE ?? "en-US-AvaNeural";

interface Source { name: string; url: string; }
interface Section { heading: string; narration: string; imageQuery?: string; sources?: Source[]; }
interface Longform {
  date: string;
  title: string;
  topic: string;
  hook: string;
  sections: Section[];
  todaysWord?: { word: string; definitionEn: string; definitionJp?: string };
  close: string;
  thumbnail?: { hook: string; stat: string };
}
interface VttCue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const lf: Longform = JSON.parse(await fs.readFile(path.join(dir, "longform.json"), "utf-8"));

  console.log(`[longform] "${lf.title}" — ${lf.sections.length} sections`);

  // 背景画像クエリの手動上書き: IMG_QUERY_OVERRIDES='{"0":"Israel Iron Dome air defense"}'。
  // 特定動画の不適切な背景を差し替える用 (Drive 台本を編集できない場合の救済)。空なら従来どおり。
  try {
    const ov = process.env.IMG_QUERY_OVERRIDES;
    if (ov && ov.trim()) {
      const map = JSON.parse(ov) as Record<string, string>;
      for (const [k, v] of Object.entries(map)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && lf.sections[idx] && typeof v === "string" && v.trim()) {
          lf.sections[idx].imageQuery = v.trim();
          console.log(`[longform] imageQuery override [${idx}] -> "${v.trim()}"`);
        }
      }
    }
  } catch (e) {
    console.warn(`[longform] IMG_QUERY_OVERRIDES parse failed (ignored): ${e instanceof Error ? e.message : e}`);
  }

  const segs: { file: string; dur: number; label: string }[] = [];

  // Intro (greeting + framing + hook)
  const introText = `Welcome back to Daily World 60. This is our weekly deep dive — where we slow down, take one big story, and unpack what really happened and why it matters. ${lf.hook} Let's get into it.`;
  segs.push({ label: "Intro", ...(await buildSegment(dir, "00-intro", introText, (cue) => titleSceneSvg(lf, cue))) });

  // Sections (背景に Wikimedia 画像 = b-roll)
  for (let i = 0; i < lf.sections.length; i++) {
    const s = lf.sections[i];
    const id = `s${(i + 1).toString().padStart(2, "0")}`;
    const srcName = s.sources?.[0]?.name ?? "";
    const q = s.imageQuery ?? s.heading;
    const cands = [q, q.split(/\s+/).slice(0, 2).join(" "), lf.topic, (lf.topic ?? "").split(/\s+/).slice(0, 2).join(" ")];
    const bgB64 = await fetchSectionBg(cands, path.join(dir, `_lfbg-img-${id}.jpg`)).catch(() => null);
    segs.push({ label: s.heading, ...(await buildSegment(dir, id, s.narration, (cue) =>
      sectionSceneSvg(s.heading, i + 1, lf.sections.length, cue, srcName, bgB64))) });
  }

  // Outro
  const outroText =
    (lf.todaysWord ? `Today's word: ${lf.todaysWord.word}. ${lf.todaysWord.definitionEn} ` : "") + lf.close;
  segs.push({ label: "Subscribe", ...(await buildSegment(dir, "99-outro", outroText, (cue) => outroSceneSvg(lf, cue))) });

  // Chapters (YouTube timestamps): 各セグメントの開始秒を記録
  let acc = 0;
  const chapters = segs.map(s => { const c = { heading: s.label, start: Math.round(acc) }; acc += s.dur; return c; });
  await fs.writeFile(path.join(dir, "longform-chapters.json"),
    JSON.stringify({ title: lf.title, chapters, totalSeconds: Math.round(acc) }, null, 2), "utf-8");

  // Concat all segments (each carries its own narration audio)
  const master = path.join(dir, "_lf-master.mp4");
  const listFile = path.join(dir, "_lf-concat.txt");
  await fs.writeFile(listFile, segs.map(s => `file '${path.resolve(s.file)}'`).join("\n"), "utf-8");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", master]);
  await fs.unlink(listFile).catch(() => {});

  // BGM mix (low volume under narration) — reuse the same news bed
  const out = path.join(dir, "longform.mp4");
  const bgmFile = process.env.BGM_PATH ?? path.join("assets", "news-bed-longform.mp3");
  const hasBgm = await fs.access(bgmFile).then(() => true).catch(() => false);
  const bgmVol = process.env.BGM_VOLUME ?? "0.10";
  if (hasBgm) {
    const dur = await ffprobeDuration(master);
    await run("ffmpeg", [
      "-y", "-i", master, "-stream_loop", "-1", "-i", bgmFile,
      "-filter_complex", `[0:a]volume=1.0[vo];[1:a]volume=${bgmVol}[bg];[vo][bg]amix=inputs=2:duration=first:normalize=0[mix]`,
      "-map", "0:v:0", "-map", "[mix]", "-t", dur.toFixed(2),
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", out,
    ]);
  } else {
    await fs.rename(master, out);
  }

  // cleanup
  for (const s of segs) await fs.unlink(s.file).catch(() => {});
  await fs.unlink(master).catch(() => {});

  const stat = await fs.stat(out);
  const total = await ffprobeDuration(out);
  console.log(`[longform] → ${out} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${(total / 60).toFixed(1)} min)`);
}

/** TTS text -> VTT -> cue ごとに sceneSvg() でシーン化 -> 連結 -> 音声 mux した segment.mp4 を返す。 */
async function buildSegment(
  dir: string,
  id: string,
  text: string,
  sceneSvg: (cueText: string, i: number) => string,
): Promise<{ file: string; dur: number }> {
  const mp3 = path.join(dir, `_lfa-${id}.mp3`);
  const vtt = path.join(dir, `_lfa-${id}.vtt`);
  await run("edge-tts", [
    "--voice", VOICE, "--rate=-10%", "--pitch=+0Hz",
    "--text", text, "--write-media", mp3, "--write-subtitles", vtt,
  ]);
  const cues = await parseVtt(vtt);
  const audioDur = await ffprobeDuration(mp3);
  const total = audioDur + 0.3;

  const sceneMp4s: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const dur = Math.max(0.2, cue.end - cue.start);
    const svgPath = path.join(dir, `_lfs-${id}-${i}.svg`);
    const pngPath = path.join(dir, `_lfs-${id}-${i}.png`);
    const mp4Path = path.join(dir, `_lfs-${id}-${i}.mp4`);
    await fs.writeFile(svgPath, sceneSvg(cue.text, i), "utf-8");
    await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
    await fs.unlink(svgPath).catch(() => {});
    await run("ffmpeg", [
      "-y", "-loop", "1", "-i", pngPath, "-t", dur.toFixed(3),
      "-vf", `scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
      mp4Path,
    ]);
    await fs.unlink(pngPath).catch(() => {});
    sceneMp4s.push(mp4Path);
  }

  // concat silent scenes
  const listFile = path.join(dir, `_lfc-${id}.txt`);
  await fs.writeFile(listFile, sceneMp4s.map(s => `file '${path.resolve(s)}'`).join("\n"), "utf-8");
  const bgVideo = path.join(dir, `_lfbg-${id}.mp4`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", bgVideo]);
  await fs.unlink(listFile).catch(() => {});

  // mux narration audio
  const seg = path.join(dir, `_lfseg-${id}.mp4`);
  await run("ffmpeg", [
    "-y", "-i", bgVideo, "-i", mp3, "-map", "0:v:0", "-map", "1:a:0",
    "-t", total.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-r", String(FPS), seg,
  ]);

  for (const s of sceneMp4s) await fs.unlink(s).catch(() => {});
  await fs.unlink(bgVideo).catch(() => {});
  await fs.unlink(mp3).catch(() => {});
  await fs.unlink(vtt).catch(() => {});
  console.log(`[longform] segment ${id}: ${cues.length} cues, ${total.toFixed(1)}s`);
  return { file: seg, dur: total };
}

// ─────────── SVG scenes (1920x1080) ───────────

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** fitTextBox の行配列を tspan 群にする (折り返しは実測幅で済んでいる)。 */
function tspanLines(lines: string[], x: number, dy: number): string {
  return lines.map((ln, i) =>
    `<tspan x="${x}" dy="${i === 0 ? 0 : dy}">${escape(ln)}</tspan>`).join("");
}

const BG = `<rect width="${W}" height="${H}" fill="#0B1220"/>
  <rect width="${W}" height="8" fill="#F5E63B"/>
  <rect y="${H - 8}" width="${W}" height="8" fill="#F5E63B"/>`;

function titleSceneSvg(lf: Longform, cue: string): string {
  // タイトル・cue とも実測幅で 1700px 箱にフィット (はみ出し防止)
  const tFit = fitTextBox(lf.title, 1700, 460, [88, 80, 72, 64, 56, 48, 42]);
  const cFit = fitTextBox(cue, 1700, 280, [44, 40, 36, 32, 28, 24]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${BG}
  <text x="${W / 2}" y="150" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="34" fill="#F5E63B" letter-spacing="6">DAILY WORLD 60 · DEEP DIVE</text>
  <text x="${W / 2}" y="430" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${tFit.fontSize}" fill="#FFFFFF">${tspanLines(tFit.lines, W / 2, tFit.lineHeight)}</text>
  <text x="${W / 2}" y="930" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="${cFit.fontSize}" fill="#9FB3D8">${tspanLines(cFit.lines, W / 2, cFit.lineHeight)}</text>
</svg>`;
}

function sectionSceneSvg(heading: string, num: number, total: number, cue: string, source: string, bgB64?: string | null): string {
  const bg = bgB64
    ? `<image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,${bgB64}"/>
  <rect width="${W}" height="${H}" fill="#0B1220" opacity="0.62"/>
  <rect width="${W}" height="8" fill="#F5E63B"/><rect y="${H - 8}" width="${W}" height="8" fill="#F5E63B"/>`
    : BG;
  const hFs = fitSingleLine(heading, W - 200 - 240, 50);
  const cFit = fitTextBox(cue, 1700, 520, [62, 56, 50, 44, 38, 32, 28]);
  const srcLine = source ? `SOURCE: ${source}` : "";
  const srcFs = srcLine ? fitSingleLine(srcLine, W - 180, 28) : 0;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${bg}
  <rect x="90" y="90" width="84" height="84" rx="14" fill="#F5E63B"/>
  <text x="132" y="150" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0B1220">${num}</text>
  <text x="200" y="150" font-family="Hiragino Sans" font-weight="900"
        font-size="${hFs}" fill="#FFFFFF">${escape(heading)}</text>
  <text x="${W - 90}" y="150" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="30" fill="#5C6B8A">${num} / ${total}</text>
  <text x="${W / 2}" y="600" text-anchor="middle" font-family="Hiragino Sans" font-weight="700"
        font-size="${cFit.fontSize}" fill="#FFFFFF">${tspanLines(cFit.lines, W / 2, cFit.lineHeight)}</text>
  ${srcLine ? `<text x="90" y="${H - 60}" font-family="Hiragino Sans" font-weight="600"
        font-size="${srcFs}" fill="#5C6B8A">${escape(srcLine)}</text>` : ""}
</svg>`;
}

function outroSceneSvg(lf: Longform, cue: string): string {
  const w = lf.todaysWord;
  const wordLine = w ? `Word: ${w.word}` : "";
  const wFs = wordLine ? fitSingleLine(wordLine, 1700, 56) : 0;
  const cFit = fitTextBox(cue, 1700, 320, [40, 36, 32, 28, 24]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${BG}
  <text x="${W / 2}" y="240" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#F5E63B" letter-spacing="4">SUBSCRIBE</text>
  <text x="${W / 2}" y="320" text-anchor="middle" font-family="Hiragino Sans" font-weight="700"
        font-size="38" fill="#FFFFFF">A deep dive into one big story, every week.</text>
  ${wordLine ? `<text x="${W / 2}" y="520" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${wFs}" fill="#9FB3D8">${escape(wordLine)}</text>` : ""}
  <text x="${W / 2}" y="760" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="${cFit.fontSize}" fill="#9FB3D8">${tspanLines(cFit.lines, W / 2, cFit.lineHeight)}</text>
  <text x="${W / 2}" y="${H - 70}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="32" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

// ─────────── helpers ───────────

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const UA = "DailyWorld60/1.0 (longform b-roll)";

/** Wikimedia Commons から query に合う横向き写真を 1 枚取得し、1920x1080 cover にして base64 を返す。 */
async function searchOneBg(query: string, dest: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query", format: "json", generator: "search",
    gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|mime|size", iiurlwidth: "1920",
  });
  const res = await fetch(`${COMMONS_API}?${params}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const json = await res.json() as { query?: { pages?: Record<string, {
    title: string; index?: number;
    imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string; width?: number }>;
  }> } };
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  const cands = pages
    .map(p => ({ p, ii: p.imageinfo?.[0] }))
    .filter(x => !!x.ii && /image\/jpeg/.test(x.ii!.mime ?? "") && (x.ii!.width ?? 0) >= 1000)
    .filter(x => !/\b(flag|logo|icon|coat of arms|seal|emblem|map|chart|diagram|locator|infographic)\b/i.test(x.p.title))
    .sort((a, b) => (a.p.index ?? 999) - (b.p.index ?? 999));
  const url = cands[0]?.ii?.thumburl ?? cands[0]?.ii?.url;
  if (!url) { console.log(`[longform] bg: "${query}" -> none`); return null; }
  const img = await fetch(url, { headers: { "User-Agent": UA } });
  if (!img.ok) return null;
  const buf = Buffer.from(await img.arrayBuffer());
  await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).jpeg({ quality: 80 }).toFile(dest);
  console.log(`[longform] bg: "${query}" -> ${cands[0]!.p.title}`);
  return (await fs.readFile(dest)).toString("base64");
}

/** 複数の候補クエリを順に試し、最初に画像が取れたものを返す (具体→2語→topic の順)。 */
async function fetchSectionBg(queries: string[], dest: string): Promise<string | null> {
  const seen = new Set<string>();
  for (const q of queries) {
    const t = (q ?? "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    const r = await searchOneBg(t, dest).catch(() => null);
    if (r) return r;
  }
  return null;
}

async function parseVtt(file: string): Promise<VttCue[]> {
  // edge-tts は SRT 風 (cue番号 / タイムスタンプ / 本文)。タイムスタンプ行を見つけ、
  // 続く非空行を本文として集める (build-news-video と同方式)。
  const lines = (await fs.readFile(file, "utf-8")).split(/\r?\n/);
  const cues: VttCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    let txt = "";
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) txt += lines[j].replace(/<[^>]+>/g, "") + " ";
    txt = txt.trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  return cues;
}

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", d => { out += d; });
    proc.on("close", () => resolve(parseFloat(out.trim()) || 0));
    proc.on("error", reject);
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    proc.on("error", reject);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
