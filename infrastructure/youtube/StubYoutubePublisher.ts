import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

/**
 * TODO: YouTube Data API v3 で本実装。OAuth セットアップ済み credentials を使う。
 */
export class StubYoutubePublisher implements PublisherPort {
  readonly platform = "youtube" as const;

  async publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult> {
    if (options?.dryRun) {
      return { platform: this.platform, ok: true, url: "(dry-run)", draft: true };
    }
    console.warn(`[youtube] STUB publish title="${post.title}", videoPath=${post.videoPath}`);
    return {
      platform: this.platform,
      ok: false,
      error: "YouTube publisher not implemented yet — see TODO",
      draft: true,
    };
  }
}
