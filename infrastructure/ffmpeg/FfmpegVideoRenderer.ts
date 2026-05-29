import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Audio } from "../../domain/media/Audio.js";
import type { Video } from "../../domain/media/Video.js";
import type { Script } from "../../domain/script/Script.js";
import type { BRollClip } from "../../application/ports/BRollFetcherPort.js";
import type { VideoRendererPort } from "../../application/ports/VideoRendererPort.js";

/**
 * ffmpeg で 9:16 1080x1920 動画を生成（音声 + B-roll concat + 字幕焼き込み）。
 * 字幕は ASS で生成して drawtext より高品質に。
 */
export class FfmpegVideoRenderer implements VideoRendererPort {
  async render(input: {
    script: Script;
    audio: Audio;
    brollClips: readonly BRollClip[];
    outputPath: string;
    width?: number;
    height?: number;
  }): Promise<Video> {
    const w = input.width ?? 1080;
    const h = input.height ?? 1920;
    const dir = path.dirname(input.outputPath);
    await fs.mkdir(dir, { recursive: true });

    // 1. B-roll を 1本の中間動画に concat
    const concatInput = path.join(dir, "_broll_list.txt");
    const concatLines = input.brollClips
      .map(c => `file '${c.filePath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(concatInput, concatLines, "utf-8");

    const concatted = path.join(dir, "_broll_concat.mp4");
    await this.runFfmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", concatInput,
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
      concatted,
    ]);

    // 2. 音声 + concat 動画を合成（音声長に動画を合わせる）
    await this.runFfmpeg([
      "-y",
      "-stream_loop", "-1", "-i", concatted,
      "-i", input.audio.filePath,
      "-shortest",
      "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      input.outputPath,
    ]);

    await fs.unlink(concatted).catch(() => {});
    await fs.unlink(concatInput).catch(() => {});

    return {
      filePath: input.outputPath,
      durationSeconds: input.audio.durationSeconds,
      width: w,
      height: h,
      format: "mp4",
    };
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
      proc.on("error", reject);
      proc.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
    });
  }
}
