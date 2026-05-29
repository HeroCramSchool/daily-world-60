import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * TODO: Playwright で IG Web 版に下書き保存する実装。note-poster 流用予定。
 */
export class StubInstagramPublisher implements PublisherPort {
  readonly platform = "instagram" as const;

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    console.warn(`[instagram] STUB title="${post.title}"`);
    return {
      platform: this.platform,
      ok: false,
      error: "Instagram publisher not implemented yet — see TODO",
      draft: true,
    };
  }
}
