import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * TODO: X (Twitter) API v2 でスレッド投稿を本実装。
 * 既存 twitter-automation Skill 経由でも可。
 */
export class StubXPublisher implements PublisherPort {
  readonly platform = "x" as const;

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return {
        platform: this.platform,
        ok: true,
        url: "(dry-run)",
        draft: true,
      };
    }
    if (!post.thread || post.thread.length === 0) {
      return { platform: this.platform, ok: false, error: "Empty thread" };
    }
    console.warn(`[x] STUB thread tweets=${post.thread.length}`);
    return {
      platform: this.platform,
      ok: false,
      error: "X publisher not implemented yet — see TODO",
      draft: true,
    };
  }
}
