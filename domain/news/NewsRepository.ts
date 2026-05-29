import type { NewsArticle } from "./NewsArticle.js";
import type { NewsSource } from "./NewsSource.js";

export interface FetchOptions {
  /** 何時間以内の記事を対象とするか（デフォルト 24h） */
  sinceHours?: number;
  /** 各ソースから取得する最大記事数 */
  perSourceLimit?: number;
}

export interface NewsRepository {
  fetchAll(sources: readonly NewsSource[], options?: FetchOptions): Promise<NewsArticle[]>;
}
