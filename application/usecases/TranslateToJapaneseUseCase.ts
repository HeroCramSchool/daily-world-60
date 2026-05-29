import type { Script } from "../../domain/script/Script.js";
import { Country } from "../../domain/shared/Country.js";
import type { ClaudeApiPort } from "../ports/ClaudeApiPort.js";

const SYSTEM_PROMPT = `あなたは Daily World 60 の日本版 X (Twitter) 編集者です。

協働 Skill（推論時に活用すること）:
- twitter-automation: X スレッドの最適構造・投稿タイミング
- twitter-thread-creation: フック・引き・誘導の型
- social: マルチプラットフォーム展開を意識した copywriting
- content-strategy: 日本人英語学習者ターゲットの編集判断

任務:
- 英語スクリプトの3ストーリーを日本語化し、X の140字制限に収める
- ハッシュタグ #世界ニュース #DailyWorld60 を付ける
- AI臭除去ルール厳守 (~/.company/marketing/ai-smell-removal-guide.md):
  - 禁止語: いかがでしたか / ぜひ〜してみてください / ご紹介します / することができます / と考えられます / 結論として
  - 禁止記号: em-dash (—), 過剰な強調
  - 文末3連続同一禁止（です/ます/だ/である を混ぜる）
- 出典名は短縮可（"BBC News" → "BBC"）
- 客観報道調、個人意見は入れない

絵文字使用: 国旗のみ。それ以外は使わない。`;

interface TranslationOutput {
  stories: Array<{
    index: number;
    headlineJp: string;
    summaryJp: string;
    sourceShort: string;
  }>;
  todaysWordJp: string; // "停戦" のような短い日本語訳
}

export class TranslateToJapaneseUseCase {
  constructor(private readonly claude: ClaudeApiPort) {}

  async execute(script: Script): Promise<Script> {
    if (script.language !== "en") {
      throw new Error("Input script must be 'en'");
    }

    const prompt = this.buildPrompt(script);
    const output = await this.claude.generateJson<TranslationOutput>({
      system: SYSTEM_PROMPT,
      prompt,
      jsonSchemaName: "daily-world-60-jp-translation",
      maxTokens: 1500,
    });

    return {
      date: script.date,
      language: "jp",
      hook: `${script.date.slice(5).replace("-", "/")}の世界ニューストップ3`,
      stories: output.stories.map(t => {
        const src = script.stories.find(s => s.index === t.index);
        if (!src) throw new Error(`Story index ${t.index} not found in source`);
        return {
          index: t.index,
          country: Country.fromCode(src.country.code),
          headline: t.headlineJp,
          summary: t.summaryJp,
          sourceName: t.sourceShort,
          sourceUrl: src.sourceUrl,
        };
      }),
      todaysWord: {
        ...script.todaysWord,
        definitionJp: output.todaysWordJp || script.todaysWord.definitionJp,
      },
      close: "英語版（60秒動画）は YouTube / TikTok / Instagram で配信中 @DailyWorld60",
    };
  }

  private buildPrompt(script: Script): string {
    const lines: string[] = [
      "以下の英語スクリプトを X 日本版に翻訳してください。",
      "",
      `日付: ${script.date}`,
      "",
      "ストーリー:",
    ];
    for (const s of script.stories) {
      lines.push(`【${s.index}】 ${s.country.code} ${s.country.flag}`);
      lines.push(`  Headline: ${s.headline}`);
      lines.push(`  Summary: ${s.summary}`);
      lines.push(`  Source: ${s.sourceName}`);
      lines.push("");
    }
    lines.push(`Today's word: ${script.todaysWord.word} (${script.todaysWord.definitionEn})`);
    lines.push("");
    lines.push("出力JSON:");
    lines.push(`{
  "stories": [
    { "index": 1, "headlineJp": "...", "summaryJp": "...", "sourceShort": "BBC" }
  ],
  "todaysWordJp": "停戦"
}`);
    lines.push("");
    lines.push("重要な制約:");
    lines.push("- headlineJp: 30字以内の名詞句、句点なし");
    lines.push("- summaryJp: 60字以内、文末「。」で締める。出典名・URL・ハッシュタグは絶対に含めない（コード側で自動付与する）");
    lines.push("- sourceShort: 媒体名のみ短く（例「BBC」「DW」「Al Jazeera」）。「出典:」「Source:」プレフィックス不要");
    lines.push("- todaysWordJp: 10字以内の純粋な日本語訳");
    lines.push("- 国旗絵文字は出力しない（コード側で付与）");
    return lines.join("\n");
  }
}
