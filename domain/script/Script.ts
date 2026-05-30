import type { Language } from "../shared/Language.js";
import { Country } from "../shared/Country.js";
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
    const last = script.stories.length;
    for (const s of script.stories) {
      const lead =
        s.index === 1 ? "First, from" :
        s.index === last ? "And finally, from" :
        "Next news, from";
      const countryName = s.country.name ?? Country.nameOf(s.country.code);
      lines.push(`${lead} ${countryName}. ${s.headline}. ${s.summary}`);
    }
    lines.push(`Today's word: ${script.todaysWord.word}. ${script.todaysWord.definitionEn}.`);
    lines.push(script.close);
    return lines.join(" ");
  },

  /**
   * 1ストーリー単独 60秒動画用のナレーション。
   * 目標発話時間: 45-50秒 (動画 60秒に対し 10-15秒の outro hold を残す)。
   */
  toStoryNarration(s: { country: { code: string; name?: string }; headline: string; summary: string },
                   todaysWord: TodaysWord): string {
    const countryName = s.country.name ?? Country.nameOf(s.country.code);
    return [
      `Welcome to Daily World 60.`,
      `Today's news comes from ${countryName}.`,
      `${s.headline}.`,
      `Here are the details.`,
      s.summary,
      `Now, let's learn an English word from this story.`,
      `The word of the day is ${todaysWord.word}.`,
      `${todaysWord.definitionEn}.`,
      `Try using this word in your English today.`,
      `Thank you for watching Daily World 60.`,
      `If you enjoyed this story, please subscribe and follow.`,
      `We bring you world news every single day.`,
      `See you tomorrow.`,
    ].join(" ");
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
