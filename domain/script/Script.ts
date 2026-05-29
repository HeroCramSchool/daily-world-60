import type { Language } from "../shared/Language.js";
import type { Story } from "./Story.js";
import type { TodaysWord } from "./TodaysWord.js";

/**
 * 1日分のスクリプト（言語別）。
 * - en: YouTube Shorts / IG Reels / TikTok の動画ナレーション用
 * - jp: X のスレッド用
 */
export interface Script {
  readonly date: string; // YYYY-MM-DD
  readonly language: Language;
  readonly hook: string;
  readonly stories: readonly Story[];
  readonly todaysWord: TodaysWord;
  readonly close: string;
  /** 動画用の総秒数推定（en のみ。jp は X 文字数で別管理） */
  readonly estimatedSeconds?: number;
}

export const Script = {
  toNarration(script: Script): string {
    const lines = [script.hook];
    for (const s of script.stories) {
      lines.push(`Story ${s.index} from ${s.country.flag} ${s.country.code}. ${s.headline}. ${s.summary}`);
    }
    lines.push(`Today's word: ${script.todaysWord.word}. ${script.todaysWord.definitionEn}.`);
    lines.push(script.close);
    return lines.join(" ");
  },

  toXThread(script: Script): string[] {
    // 1ツイート目: 導入
    const date = script.date.replace(/-/g, "/").slice(5); // MM/DD
    const tweets: string[] = [`🌍 ${date}の世界ニューストップ3\n#DailyWorld60 #世界ニュース`];
    // 各ストーリー
    for (const s of script.stories) {
      tweets.push(
        `${s.country.flag} ${s.headline}\n${s.summary}\nソース: ${s.sourceName}\n#世界ニュース`,
      );
    }
    // 締め: Today's word + 英語版誘導
    tweets.push(
      `今日の英単語: "${script.todaysWord.word}" = ${script.todaysWord.definitionJp}\n\n英語版（60秒動画）はYouTube / TikTok / Instagram で配信中 → @DailyWorld60`,
    );
    return tweets;
  },
};
