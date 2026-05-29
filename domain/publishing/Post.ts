import type { Platform } from "./Platform.js";

/**
 * プラットフォーム横断の投稿表現。
 * 動画系は videoPath / thumbnailPath、X はテキストスレッド。
 */
export interface Post {
  readonly platform: Platform;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly videoPath?: string;
  readonly thumbnailPath?: string;
  readonly thread?: readonly string[];
}
