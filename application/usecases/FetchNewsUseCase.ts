import type { NewsArticle } from "../../domain/news/NewsArticle.js";
import type { NewsRepository, FetchOptions } from "../../domain/news/NewsRepository.js";
import type { NewsSource } from "../../domain/news/NewsSource.js";

export class FetchNewsUseCase {
  constructor(private readonly repo: NewsRepository) {}

  async execute(input: {
    sources: readonly NewsSource[];
    options?: FetchOptions;
  }): Promise<NewsArticle[]> {
    const articles = await this.repo.fetchAll(input.sources, input.options);
    // 必要なら共通正規化はここで（src 内の HTML タグ除去など）
    return articles;
  }
}
