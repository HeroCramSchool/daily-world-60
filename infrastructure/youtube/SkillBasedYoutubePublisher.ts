import { spawn } from "node:child_process";
import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * `youtube` Skill 経由で YouTube に投稿する。
 * Claude Code CLI に「youtube Skill を起動して動画をアップして」と依頼する。
 *
 * 動作要件:
 * - `youtube` Skill がインストール済み（npx skills add で導入済み）
 * - Claude CLI が PATH にある
 * - 初回は Skill 内の OAuth フローでブラウザ認証必要
 */
export class SkillBasedYoutubePublisher implements PublisherPort {
  readonly platform = "youtube" as const;

  constructor(private readonly options?: { binary?: string; timeoutMs?: number; cwd?: string }) {}

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    if (!post.videoPath) {
      return { platform: this.platform, ok: false, error: "videoPath missing" };
    }
    const prompt = [
      "Use the `youtube` skill to upload this video to YouTube as a Short.",
      "",
      `Video path: ${post.videoPath}`,
      `Title: ${post.title}`,
      `Description:`,
      post.description,
      "",
      `Tags: ${post.tags.join(", ")}`,
      `Thumbnail: ${post.thumbnailPath ?? "(generate or skip)"}`,
      "",
      "Use `category=News & Politics`, `madeForKids=false`, `privacyStatus=public`.",
      "Reply with raw JSON: {\"ok\": boolean, \"url\": string, \"id\": string}",
    ].join("\n");
    return this.callClaude(prompt);
  }

  private callClaude(prompt: string): Promise<PublishingResult> {
    return new Promise((resolve) => {
      const binary = this.options?.binary ?? "claude";
      const args = ["-p", prompt, "--output-format", "text"];
      const proc = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.options?.cwd,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ platform: this.platform, ok: false, error: "claude timeout" });
      }, this.options?.timeoutMs ?? 600_000);
      proc.stdout.on("data", d => (stdout += d.toString()));
      proc.stderr.on("data", d => (stderr += d.toString()));
      proc.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ platform: this.platform, ok: false, error: stderr.slice(0, 300) });
          return;
        }
        try {
          const cleaned = stdout.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
          const j = JSON.parse(cleaned.slice(cleaned.indexOf("{")));
          resolve({ platform: this.platform, ok: !!j.ok, url: j.url, id: j.id });
        } catch (e) {
          resolve({
            platform: this.platform,
            ok: false,
            error: `parse: ${e instanceof Error ? e.message : e}`,
          });
        }
      });
    });
  }
}
