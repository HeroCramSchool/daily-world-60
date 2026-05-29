import type { NewsArticle } from "./NewsArticle.js";
import type { NewsCurationCriteria } from "./NewsCurationCriteria.js";

/**
 * 候補ショートリストを作るドメインサービス。
 * 最終的な Top N 選定は LLM に委ねるが、その前段の決定論的フィルタはここに置く。
 */
export class NewsCurationService {
  shortlist(articles: readonly NewsArticle[], criteria: NewsCurationCriteria): NewsArticle[] {
    const cutoff = Date.now() - criteria.recencyHours * 3600 * 1000;

    const filtered = articles.filter(a => {
      if (a.publishedAt.getTime() < cutoff) return false;
      if (criteria.excludeSourceIds.includes(a.source.id)) return false;
      if (criteria.excludeRegions.includes(a.source.region)) return false;
      return true;
    });

    // 同一URLや極端に近いタイトルは重複扱い（同一見出しの重複防止）
    const seen = new Set<string>();
    const deduped = filtered.filter(a => {
      const key = normalizeTitle(a.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 地域多様性を担保するため、地域ごとに最新順で取る
    if (criteria.preferDiverseRegions) {
      return this.pickDiverse(deduped, criteria.shortlistSize);
    }

    return deduped
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, criteria.shortlistSize);
  }

  private pickDiverse(articles: readonly NewsArticle[], limit: number): NewsArticle[] {
    const byRegion = new Map<string, NewsArticle[]>();
    for (const a of articles) {
      const list = byRegion.get(a.source.region) ?? [];
      list.push(a);
      byRegion.set(a.source.region, list);
    }
    for (const list of byRegion.values()) {
      list.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    }

    // ラウンドロビン式に各地域から1本ずつ取る
    const result: NewsArticle[] = [];
    const queues = Array.from(byRegion.values());
    let progress = true;
    while (result.length < limit && progress) {
      progress = false;
      for (const q of queues) {
        const next = q.shift();
        if (next) {
          result.push(next);
          progress = true;
          if (result.length >= limit) break;
        }
      }
    }
    return result;
  }
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
}
