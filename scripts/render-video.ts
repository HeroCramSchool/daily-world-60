import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

const W = 1080;
const H = 1920;
const FPS = 30;

/**
 * 字幕入り最終動画を組み立てる。
 * 前提: scripts/build-scenes.ts が _bg.mp4 (60s) を作っている。
 *       scripts/tts.ts が voice.mp3 + voice.vtt を作っている。
 *
 * 字幕スタイル (research-brief-2026.md 準拠):
 * - FontName: Hiragino Sans (W9 相当の Bold=1)
 * - FontSize: 14 (libass の PlayResY=288 ベース → 約 96px on 1920 = リサーチの 72pt)
 * - Outline: 8px hard black, Shadow=2
 * - MarginV=620 → 字幕は Y≒1200px (下から 1/3 上)
 * - Alignment=2 (下中央)
 */

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const bg = path.join(dir, "_bg.mp4");
  const audio = path.join(dir, "voice.mp3");
  const subs = path.join(dir, "voice.vtt");
  const out = path.join(dir, "final.mp4");

  const audioDuration = await ffprobeDuration(audio);
  console.log(`[render] audio = ${audioDuration.toFixed(2)}s, bg = 60s`);

  // libass が無い ffmpeg では字幕 burn-in できないので、SVG で各シーンに headline を
  // 大きく焼いてある（build-scenes.ts）。字幕はオプション。

  const cwd = path.dirname(subs);
  await run(
    "ffmpeg",
    [
      "-y",
      "-i", path.basename(bg),
      "-i", path.basename(audio),
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-t", audioDuration.toFixed(3),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      path.basename(out),
    ],
    cwd,
  );

  const stat = await fs.stat(out);
  console.log(`[render] ${out} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  // 中間ファイル掃除
  const intermediate = [
    "_bg.mp4",
    "_scene-01-intro.png", "_scene-02-story1.png",
    "_scene-03-story2.png", "_scene-04-story3.png", "_scene-05-outro.png",
    "_scene-01-intro.mp4", "_scene-02-story1.mp4",
    "_scene-03-story2.mp4", "_scene-04-story3.mp4", "_scene-05-outro.mp4",
  ];
  for (const f of intermediate) {
    await fs.unlink(path.join(dir, f)).catch(() => {});
  }
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], cwd });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
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
