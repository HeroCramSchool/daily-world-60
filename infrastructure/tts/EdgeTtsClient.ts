import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type { Audio } from "../../domain/media/Audio.js";
import type { VoiceProfile } from "../../domain/media/VoiceProfile.js";
import type { TTSPort } from "../../application/ports/TTSPort.js";

/**
 * Microsoft Edge TTS (無料・無制限) を CLI 経由で呼ぶ実装。
 * 事前に `pip install edge-tts` が必要。
 */
export class EdgeTtsClient implements TTSPort {
  constructor(private readonly options?: { binary?: string | undefined }) {}

  async synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
  }): Promise<Audio> {
    const binary = this.options?.binary ?? "edge-tts";
    const args = [
      "--voice", input.voice.id,
      "--rate", input.voice.rate,
      "--pitch", input.voice.pitch,
      "--text", input.text,
      "--write-media", input.outputPath,
    ];

    await this.run(binary, args);

    const stat = await fs.stat(input.outputPath);
    if (stat.size === 0) {
      throw new Error("edge-tts produced empty file");
    }
    // 所要秒数の推定（語数 ÷ 2.5 = だいたい英語のナチュラル発話速度）
    const wordCount = input.text.split(/\s+/).filter(Boolean).length;
    const durationSeconds = Math.round(wordCount / 2.5);

    return {
      filePath: input.outputPath,
      durationSeconds,
      format: "mp3",
    };
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
      proc.on("error", reject);
      proc.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}`));
      });
    });
  }
}
