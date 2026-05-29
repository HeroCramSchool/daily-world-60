import { spawn } from "node:child_process";
import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * X (Twitter) スレッド投稿。
 * - `twitter-automation` Skill で投稿（inference.sh CLI 経由）
 * - `twitter-thread-creation` Skill でスレッド構造を最終チェック
 */
export class SkillBasedXPublisher implements PublisherPort {
  readonly platform = "x" as const;

  constructor(private readonly options?: { binary?: string; timeoutMs?: number; cwd?: string }) {}

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    if (!post.thread || post.thread.length === 0) {
      return { platform: this.platform, ok: false, error: "thread missing" };
    }
    const prompt = [
      "Step 1: Use `twitter-thread-creation` skill to verify the thread structure (hook → stories → close).",
      "Step 2: Use `twitter-automation` skill (inference.sh x/post-create) to post the thread to the Daily World 60 日本版 X account.",
      "",
      "Thread to post (each line = one tweet):",
      "---",
      ...post.thread.map((t, i) => `[Tweet ${i + 1}]\n${t}`),
      "---",
      "",
      "Reply with raw JSON: {\"ok\": boolean, \"firstTweetUrl\": string, \"tweetIds\": string[]}",
    ].join("\n");

    return new Promise(resolve => {
      const proc = spawn(
        this.options?.binary ?? "claude",
        ["-p", prompt, "--output-format", "text"],
        { stdio: ["ignore", "pipe", "pipe"], cwd: this.options?.cwd },
      );
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
          resolve({
            platform: this.platform,
            ok: false,
            error: stderr.slice(0, 300),
          });
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
            platform: this.platform,
            ok: !!j.ok,
            url: j.firstTweetUrl,
            id: j.tweetIds?.[0],
          });
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
