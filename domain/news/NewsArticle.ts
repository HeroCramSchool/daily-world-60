import type { NewsSource } from "./NewsSource.js";

export interface NewsArticle {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly source: NewsSource;
  readonly publishedAt: Date;
  readonly topics: readonly string[];
}

export const NewsArticle = {
  create(input: {
    title: string;
    summary: string;
    url: string;
    source: NewsSource;
    publishedAt: Date;
    topics?: readonly string[];
  }): NewsArticle {
    return {
      id: hashId(input.url),
      title: input.title.trim(),
      summary: input.summary.trim(),
      url: input.url,
      source: input.source,
      publishedAt: input.publishedAt,
      topics: input.topics ?? [],
    };
  },
};

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
