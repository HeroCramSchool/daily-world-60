import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

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

  const segs: { file: string; dur: number; label: string }[] = [];

  // Intro
  segs.push({ label: "Intro", ...(await buildSegment(dir, "00-intro", lf.hook, (cue) => titleSceneSvg(lf, cue))) });

  // Sections
  for (let i = 0; i < lf.sections.length; i++) {
    const s = lf.sections[i];
    const id = `s${(i + 1).toString().padStart(2, "0")}`;
    const srcName = s.sources?.[0]?.name ?? "";
    segs.push({ label: s.heading, ...(await buildSegment(dir, id, s.narration, (cue) =>
      sectionSceneSvg(s.heading, i + 1, lf.sections.length, cue, srcName))) });
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
  const bgmFile = process.env.BGM_PATH ?? path.join("assets", "news-bed.mp3");
  const hasBgm = await fs.access(bgmFile).then(() => true).catch(() => false);
  const bgmVol = process.env.BGM_VOLUME ?? "0.08";
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

/** 文字列を最大幅で折り返し、tspan 行配列を返す。 */
function wrapTspans(text: string, charsPerLine: number, x: number, dy: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > charsPerLine) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.map((ln, i) =>
    `<tspan x="${x}" dy="${i === 0 ? 0 : dy}">${escape(ln)}</tspan>`).join("");
}

const BG = `<rect width="${W}" height="${H}" fill="#0B1220"/>
  <rect width="${W}" height="8" fill="#F5E63B"/>
  <rect y="${H - 8}" width="${W}" height="8" fill="#F5E63B"/>`;

function titleSceneSvg(lf: Longform, cue: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${BG}
  <text x="${W / 2}" y="150" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="34" fill="#F5E63B" letter-spacing="6">DAILY WORLD 60 · DEEP DIVE</text>
  <text x="${W / 2}" y="430" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="76" fill="#FFFFFF">${wrapTspans(lf.title, 36, W / 2, 92)}</text>
  <text x="${W / 2}" y="930" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="40" fill="#9FB3D8">${wrapTspans(cue, 70, W / 2, 52)}</text>
</svg>`;
}

function sectionSceneSvg(heading: string, num: number, total: number, cue: string, source: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${BG}
  <rect x="90" y="90" width="84" height="84" rx="14" fill="#F5E63B"/>
  <text x="132" y="150" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="46" fill="#0B1220">${num}</text>
  <text x="200" y="150" font-family="Hiragino Sans" font-weight="900"
        font-size="50" fill="#FFFFFF">${escape(heading)}</text>
  <text x="${W - 90}" y="150" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="30" fill="#5C6B8A">${num} / ${total}</text>
  <text x="${W / 2}" y="600" text-anchor="middle" font-family="Hiragino Sans" font-weight="700"
        font-size="58" fill="#FFFFFF">${wrapTspans(cue, 52, W / 2, 76)}</text>
  ${source ? `<text x="90" y="${H - 60}" font-family="Hiragino Sans" font-weight="600"
        font-size="28" fill="#5C6B8A">SOURCE: ${escape(source)}</text>` : ""}
</svg>`;
}

function outroSceneSvg(lf: Longform, cue: string): string {
  const w = lf.todaysWord;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${BG}
  <text x="${W / 2}" y="240" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="120" fill="#F5E63B" letter-spacing="4">SUBSCRIBE</text>
  <text x="${W / 2}" y="320" text-anchor="middle" font-family="Hiragino Sans" font-weight="700"
        font-size="38" fill="#FFFFFF">A deep dive into one big story, every week.</text>
  ${w ? `<text x="${W / 2}" y="520" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="56" fill="#9FB3D8">Word: ${escape(w.word)}</text>` : ""}
  <text x="${W / 2}" y="760" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="38" fill="#9FB3D8">${wrapTspans(cue, 72, W / 2, 50)}</text>
  <text x="${W / 2}" y="${H - 70}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="32" fill="#F5E63B" letter-spacing="4">@60dailyworld</text>
</svg>`;
}

// ─────────── helpers ───────────

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
