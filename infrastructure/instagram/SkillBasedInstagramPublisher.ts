import { spawn } from "node:child_process";
import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * `instagram-automation` Skill 経由で IG Reels に投稿（or 下書き保存）。
 * `instagram-content-generation` でキャプション最適化も依頼可能。
 */
export class SkillBasedInstagramPublisher implements PublisherPort {
  readonly platform = "instagram" as const;

  constructor(private readonly options?: { binary?: string; timeoutMs?: number; cwd?: string }) {}

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    if (!post.videoPath) {
      return { platform: this.platform, ok: false, error: "videoPath missing" };
    }
    const prompt = [
      "Use `instagram-automation` skill (via Rube MCP / Composio) to publish this as a Reel.",
      "Also use `instagram-content-generation` skill to optimize the caption if needed.",
      "",
      `Video path: ${post.videoPath}`,
      `Caption draft: ${post.title} | ${post.description}`,
      `Hashtags: ${post.tags.map(t => "#" + t.replace(/\s+/g, "")).join(" ")}`,
      "",
      "If publishing API access is not available, save as draft and report the draft URL.",
      "Reply with raw JSON: {\"ok\": boolean, \"url\": string, \"draft\": boolean}",
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
    }, options?.timeoutMs ?? 600_000);
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
        resolve({ platform, ok: !!j.ok, url: j.url, draft: j.draft, id: j.id });
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
