import { spawn } from "node:child_process";
import type { Script } from "../../domain/script/Script.js";
import type { Thumbnail } from "../../domain/media/Thumbnail.js";
import type { ThumbnailGeneratorPort } from "../../application/ports/ThumbnailGeneratorPort.js";

/**
 * Skill 経由でサムネ生成。
 * - `youtube-thumbnail` Skill: YT 9:16 / 16:9 サムネ（高CTR原則）
 * - `efecto-social-media` Skill: IG/TikTok 用カバー
 */
export class SkillBasedThumbnailGenerator implements ThumbnailGeneratorPort {
  constructor(
    private readonly options?: { binary?: string; timeoutMs?: number; cwd?: string },
  ) {}

  async generate(input: {
    script: Script;
    outputPath: string;
  }): Promise<Thumbnail> {
    const headlines = input.script.stories
      .map(s => `${s.country.flag} ${s.headline}`)
      .join(" | ");

    const prompt = [
      "Use `youtube-thumbnail` skill (and `efecto-social-media` if helpful) to create a thumbnail.",
      "",
      `Video title: Daily World 60 — ${input.script.date}`,
      `Headlines preview: ${headlines}`,
      `Today's word: ${input.script.todaysWord.word}`,
      "",
      "Style:",
      "- Bold sans serif text",
      "- Globe / world map background hint",
      "- Country flags from the 3 stories prominent",
      "- High contrast, CTR-optimized",
      "- 9:16 aspect ratio (Shorts/Reels/TikTok)",
      "",
      `Save the final PNG to: ${input.outputPath}`,
      "Reply with raw JSON: {\"ok\": boolean, \"path\": string}",
    ].join("\n");

    return new Promise(resolve => {
      const proc = spawn(
        this.options?.binary ?? "claude",
        ["-p", prompt, "--output-format", "text"],
        { stdio: ["ignore", "pipe", "pipe"], cwd: this.options?.cwd },
      );
      let stdout = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ filePath: input.outputPath, width: 1080, height: 1920, format: "png" });
      }, this.options?.timeoutMs ?? 600_000);
      proc.stdout.on("data", d => (stdout += d.toString()));
      proc.on("close", () => {
        clearTimeout(timer);
        // stdout のパース失敗しても、Skill 側でファイル保存している前提で進める
        resolve({
          filePath: input.outputPath,
          width: 1080,
          height: 1920,
          format: "png",
        });
      });
    });
  }
}
