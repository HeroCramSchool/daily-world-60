import { spawn } from "node:child_process";
import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * TikTok 投稿。
 * - `tiktok-captions` Skill でキャプション最適化
 * - `tiktok-research` Skill で当日のトレンド hook を参照
 * - 投稿自体は Playwright で下書き保存（公開は手動が安全）
 */
export class SkillBasedTikTokPublisher implements PublisherPort {
  readonly platform = "tiktok" as const;

  constructor(private readonly options?: { binary?: string; timeoutMs?: number; cwd?: string }) {}

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    if (!post.videoPath) {
      return { platform: this.platform, ok: false, error: "videoPath missing" };
    }
    const prompt = [
      "Step 1: Use `tiktok-captions` skill to optimize this caption for TikTok ESL audience.",
      "Step 2: Use `tiktok-research` skill to check today's trending hook patterns and align if useful.",
      "Step 3: Save the video as a TikTok draft via Playwright automation (do NOT publish).",
      "        Use the existing pattern from `~/.company/affiliate/automation/note-poster/`",
      "        (real Chrome channel, login cookie persisted, headless: false).",
      "",
      `Video path: ${post.videoPath}`,
      `Original caption: ${post.title}`,
      `Description (for reference): ${post.description}`,
      `Tags: ${post.tags.join(", ")}`,
      "",
      "Reply with raw JSON: {\"ok\": boolean, \"draft\": boolean, \"draftUrl\": string, \"optimizedCaption\": string}",
    ].join("\n");
    return runClaude(this.platform, prompt, this.options);
  }
}

function runClaude(
  platform: PublishingResult["platform"],
  prompt: string,
  options: { binary?: string; timeoutMs?: number; cwd?: string } | undefined,
): Promise<PublishingResult> {
  return new Promise(resolve => {
    const proc = spawn(
      options?.binary ?? "claude",
      ["-p", prompt, "--output-format", "text"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: options?.cwd },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ platform, ok: false, error: "claude timeout" });
    }, options?.timeoutMs ?? 900_000);
    proc.stdout.on("data", d => (stdout += d.toString()));
    proc.stderr.on("data", d => (stderr += d.toString()));
    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ platform, ok: false, error: stderr.slice(0, 300) });
        return;
      }
      try {
        const cleaned = stdout
          .trim()
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/i, "")
          .trim();
        const j = JSON.parse(cleaned.slice(cleaned.indexOf("{")));
        resolve({
          platform,
          ok: !!j.ok,
          url: j.draftUrl,
          draft: !!j.draft,
        });
      } catch (e) {
        resolve({
          platform,
          ok: false,
          error: `parse: ${e instanceof Error ? e.message : e}`,
        });
      }
    });
  });
}
