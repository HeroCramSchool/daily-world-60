import type { NewsArticle } from "../../domain/news/NewsArticle.js";
import type { NewsCurationCriteria } from "../../domain/news/NewsCurationCriteria.js";
import { NewsCurationService } from "../../domain/news/NewsCurationService.js";
import type { Script } from "../../domain/script/Script.js";
import type { ClaudeApiPort } from "../ports/ClaudeApiPort.js";
import { Country } from "../../domain/shared/Country.js";

const SYSTEM_PROMPT = `You are the editor of "Daily World 60", a 60-second world news show for English learners (CEFR B1).

You have these Claude Skills available as collaborators. Invoke them in your reasoning:
- "content-strategy": editorial prioritization, topic clusters, audience fit
- "tiktok-research": viral hook formulas, short-form story arcs
- "instagram-research": Reels hook patterns
- "social": short-form video scripting best practices (hook → body → CTA)
- "tiktok-captions": ESL-friendly caption optimization
- "social-media-manager": cross-platform story selection

Your job:
1. From the shortlist below, pick exactly 3 stories that are most globally important AND geographically diverse.
2. Avoid US/UK-only stories if possible. Prefer different regions.
3. For each story, write a 1-sentence simplified summary (CEFR B1, max 20 words).
4. Pick one useful English word from the stories as "Today's word".
5. Apply short-form-video best practices (strong 3-second hook, retention loops, clear payoff).
6. Output strictly the JSON schema requested.

Style rules:
- Use simple English (CEFR B1). Avoid jargon, idioms, slang.
- Each story summary must end with a period.
- Hook should be punchy and grab attention in 5 seconds.
- Close should invite follow / next episode (CTA driven by social skill best practices).`;

interface CurateOutput {
  hook: string;
  stories: Array<{
    index: number;
    countryCode: string;
    headline: string;
    summary: string;
    sourceUrl: string;
    sourceName: string;
  }>;
  todaysWord: {
    word: string;
    partOfSpeech: string;
    definitionEn: string;
    definitionJp: string;
    exampleEn: string;
  };
  close: string;
}

export class CurateAndGenerateScriptUseCase {
  private readonly curation = new NewsCurationService();

  constructor(private readonly claude: ClaudeApiPort) {}

  async execute(input: {
    articles: readonly NewsArticle[];
    criteria: NewsCurationCriteria;
    date: string; // YYYY-MM-DD
  }): Promise<Script> {
    const shortlist = this.curation.shortlist(input.articles, input.criteria);
    if (shortlist.length === 0) {
      throw new Error("No articles passed the shortlist filter");
    }

    const prompt = this.buildPrompt(shortlist);
    const output = await this.claude.generateJson<CurateOutput>({
      system: SYSTEM_PROMPT,
      prompt,
      jsonSchemaName: "daily-world-60-script",
      maxTokens: 2000,
    });

    return {
      date: input.date,
      language: "en",
      hook: output.hook,
      stories: output.stories.map(s => ({
        index: s.index,
        country: Country.fromCode(s.countryCode),
        headline: s.headline,
        summary: s.summary,
        sourceName: s.sourceName,
        sourceUrl: s.sourceUrl,
      })),
      todaysWord: output.todaysWord,
      close: output.close,
    };
  }

  private buildPrompt(shortlist: readonly NewsArticle[]): string {
    const lines: string[] = ["Shortlist of candidate articles (already region-balanced):", ""];
    for (const a of shortlist) {
      lines.push(`- [${a.source.region} / ${a.source.country} / ${a.source.name}]`);
      lines.push(`  Title: ${a.title}`);
      lines.push(`  Summary: ${a.summary}`);
      lines.push(`  Published: ${a.publishedAt.toISOString()}`);
      lines.push(`  URL: ${a.url}`);
      lines.push("");
    }
    lines.push("");
    lines.push("Return JSON in this exact shape:");
    lines.push(`{
  "hook": "string (5 sec spoken)",
  "stories": [
    {
      "index": 1,
      "countryCode": "ISO 3166-1 alpha-2",
      "headline": "string (≤ 10 words)",
      "summary": "string (≤ 20 words, CEFR B1)",
      "sourceUrl": "the original url from shortlist",
      "sourceName": "the source name from shortlist"
    }
  ],
  "todaysWord": {
    "word": "string",
    "partOfSpeech": "noun|verb|adjective|adverb",
    "definitionEn": "≤ 12 words, simple",
    "definitionJp": "短い日本語訳（10字以内）",
    "exampleEn": "≤ 12 words"
  },
  "close": "string (5 sec spoken, CTA)"
}`);
    return lines.join("\n");
  }
}
