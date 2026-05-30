import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

const W = 1080;
const H = 1920;
const FPS = 30;

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const audio = path.join(dir, "voice.mp3");
  const brollDir = path.join(dir, "broll");
  const out = path.join(dir, "final.mp4");

  // Collect b-roll clips (or fallback to a gradient generated background)
  let brollFiles: string[] = [];
  try {
    const list = await fs.readdir(brollDir);
    brollFiles = list.filter(f => f.endsWith(".mp4")).sort().map(f => path.join(brollDir, f));
  } catch {
    /* no broll dir */
  }

  let bgInput: string;
  if (brollFiles.length === 0) {
    console.warn("[render] no b-roll, generating gradient background");
    bgInput = path.join(dir, "_bg.mp4");
    await run("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `gradients=s=${W}x${H}:duration=60:speed=0.05:c0=0xFB923C:c1=0xDC2626`,
      "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
      bgInput,
    ]);
  } else {
    const listFile = path.join(dir, "_broll-list.txt");
    await fs.writeFile(
      listFile,
      brollFiles.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join("\n"),
      "utf-8",
    );
    bgInput = path.join(dir, "_broll-concat.mp4");
    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
      "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
      bgInput,
    ]);
    await fs.unlink(listFile).catch(() => {});
  }

  // Mix audio + loop bg + title overlay (PNG overlay, drawtext not available on some ffmpeg builds)
  // 注意: -shortest は -stream_loop と相性が悪く無限出力になることがあるため
  //       audio の長さを明示的に取得して -t で打ち切る。
  const audioDuration = await ffprobeDuration(audio);
  console.log(`[render] audio duration = ${audioDuration.toFixed(2)}s`);

  const headerPng = await buildHeaderPng(dir);

  await run("ffmpeg", [
    "-y",
    "-stream_loop", "-1", "-i", bgInput,
    "-i", headerPng,
    "-i", audio,
    "-t", audioDuration.toFixed(3),
    "-filter_complex",
    "[0:v][1:v]overlay=0:60:format=auto[v]",
    "-map", "[v]", "-map", "2:a:0",
    "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    out,
  ]);

  await fs.unlink(headerPng).catch(() => {});

  await fs.unlink(bgInput).catch(() => {});

  const stat = await fs.stat(out);
  console.log(`[render] ${out} (${stat.size} bytes)`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function buildHeaderPng(dir: string): Promise<string> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 200" width="1080" height="200">
  <rect x="120" y="40" width="840" height="120" rx="24" ry="24" fill="rgba(0,0,0,0.7)"/>
  <text x="540" y="125" text-anchor="middle"
        font-family="Helvetica, Arial Black, sans-serif"
        font-size="76" font-weight="900" fill="#FFFFFF"
        letter-spacing="6">DAILY WORLD 60</text>
</svg>`;
  const svgPath = path.join(dir, "_header.svg");
  const pngPath = path.join(dir, "_header.png");
  await fs.writeFile(svgPath, svg, "utf-8");
  await run("rsvg-convert", ["-w", "1080", "-h", "200", svgPath, "-o", pngPath]);
  await fs.unlink(svgPath).catch(() => {});
  return pngPath;
}

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    proc.stdout.on("data", chunk => (out += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n) || n <= 0) return reject(new Error(`bad duration: ${out}`));
      resolve(n);
    });
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
