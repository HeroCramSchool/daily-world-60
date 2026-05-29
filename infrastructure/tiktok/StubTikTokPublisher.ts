import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * TODO: Playwright で TikTok web upload に下書き保存。
 */
export class StubTikTokPublisher implements PublisherPort {
  readonly platform = "tiktok" as const;

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    console.warn(`[tiktok] STUB title="${post.title}"`);
    return {
      platform: this.platform,
      ok: false,
      error: "TikTok publisher not implemented yet — see TODO",
      draft: true,
    };
  }
}
