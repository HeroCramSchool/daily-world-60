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

  // Mix audio + loop bg + simple title overlay
  await run("ffmpeg", [
    "-y",
    "-stream_loop", "-1", "-i", bgInput,
    "-i", audio,
    "-shortest",
    "-vf", "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:" +
           "text='DAILY WORLD 60':fontcolor=white:fontsize=64:" +
           "x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.55:boxborderw=18",
    "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    out,
  ]);

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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
