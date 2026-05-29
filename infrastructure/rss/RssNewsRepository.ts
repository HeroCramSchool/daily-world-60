import { XMLParser } from "fast-xml-parser";
import { NewsArticle } from "../../domain/news/NewsArticle.js";
import type {
  FetchOptions,
  NewsRepository,
} from "../../domain/news/NewsRepository.js";
import type { NewsSource } from "../../domain/news/NewsSource.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "_text",
  parseTagValue: false,
});

const DEFAULT_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "DailyWorld60/0.1 (+https://github.com/hiro/daily-world-60; news aggregator)";

export class RssNewsRepository implements NewsRepository {
  async fetchAll(
    sources: readonly NewsSource[],
    options?: FetchOptions,
  ): Promise<NewsArticle[]> {
    const results = await Promise.allSettled(
      sources.map(s => this.fetchOne(s, options)),
    );

    const articles: NewsArticle[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const source = sources[i];
      if (r.status === "fulfilled") {
        articles.push(...r.value);
      } else {
        console.warn(`[rss] ${source.id} failed: ${r.reason}`);
      }
    }
    return articles;
  }

  private async fetchOne(
    source: NewsSource,
    options?: FetchOptions,
  ): Promise<NewsArticle[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(source.rssUrl, {
        headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = this.extractItems(xml);
      const limit = options?.perSourceLimit ?? 10;
      return items.slice(0, limit).map(item =>
        NewsArticle.create({
          title: this.cleanText(item.title),
          summary: this.cleanText(item.description ?? ""),
          url: item.link,
          source,
          publishedAt: this.parseDate(item.pubDate),
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private extractItems(
    xml: string,
  ): Array<{ title: string; link: string; description?: string; pubDate?: string }> {
    const root = parser.parse(xml);
    // RSS 2.0 / RDF 1.0 / Atom 1.0 をフラットに扱う
    const rss = root.rss?.channel?.item ?? root["rdf:RDF"]?.item ?? root.feed?.entry;
    const list = Array.isArray(rss) ? rss : rss ? [rss] : [];

    return list.map((it: Record<string, unknown>) => {
      const title = this.pickText(it.title);
      const linkRaw = it.link;
      const link =
        typeof linkRaw === "string"
          ? linkRaw
          : Array.isArray(linkRaw)
            ? (linkRaw.find((l: Record<string, unknown>) => l["@_rel"] === "alternate") as Record<string, unknown> | undefined)?.["@_href"] as string
              ?? (linkRaw[0] as Record<string, unknown>)?.["@_href"] as string
              ?? this.pickText(linkRaw[0])
            : (linkRaw as Record<string, unknown> | undefined)?.["@_href"] as string
              ?? this.pickText(linkRaw);
      const description = this.pickText(
        it.description ?? it.summary ?? it["content:encoded"] ?? it.content,
      );
      const pubDate = this.pickText(
        it.pubDate ?? it.published ?? it.updated ?? it["dc:date"],
      );
      return { title, link, description, pubDate };
    });
  }

  private pickText(v: unknown): string {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
      const obj = v as Record<string, unknown>;
      if (typeof obj._text === "string") return obj._text;
      if (typeof obj["#text"] === "string") return obj["#text"] as string;
    }
    return "";
  }

  private cleanText(s: string): string {
    return s
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseDate(raw?: string): Date {
    if (!raw) return new Date();
    const d = new Date(raw);
    return isNaN(d.getTime()) ? new Date() : d;
  }
}
