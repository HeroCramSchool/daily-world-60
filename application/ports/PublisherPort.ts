import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";

/**
 * プラットフォーム別の Publisher が実装する共通インターフェース。
 * infrastructure/youtube, instagram, tiktok, x がそれぞれ implements する。
 */
export interface PublisherPort {
  readonly platform: Post["platform"];
  publish(post: Post, options?: { dryRun?: boolean }): Promise<PublishingResult>;
}
