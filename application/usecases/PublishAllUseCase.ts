import type { Script } from "../../domain/script/Script.js";
import { Script as ScriptOps } from "../../domain/script/Script.js";
import type { Post } from "../../domain/publishing/Post.js";
import type { PublishingResult } from "../../domain/publishing/PublishingResult.js";
import type { Platform } from "../../domain/publishing/Platform.js";
import type { PublisherPort } from "../ports/PublisherPort.js";

/**
 * 全プラットフォームに配信する。
 * - YouTube / Instagram / TikTok: 英語動画 (videoPath + thumbnail)
 * - X: 日本語スレッド
 */
export class PublishAllUseCase {
  constructor(
    private readonly publishers: Record<Platform, PublisherPort | undefined>,
  ) {}

  async execute(input: {
    enScript: Script;
    jpScript: Script;
    videoPath: string;
    thumbnailPath: string;
    dryRun?: boolean;
  }): Promise<PublishingResult[]> {
    const enTitle = this.buildTitle(input.enScript);
    const enDescription = this.buildDescription(input.enScript);
    const enTags = this.buildTags(input.enScript);

    const posts: Post[] = [
      {
        platform: "youtube",
        title: enTitle,
        description: enDescription,
        tags: enTags,
        videoPath: input.videoPath,
        thumbnailPath: input.thumbnailPath,
      },
      {
        platform: "instagram",
        title: enTitle,
        description: enDescription,
        tags: enTags,
        videoPath: input.videoPath,
        thumbnailPath: input.thumbnailPath,
      },
      {
        platform: "tiktok",
        title: enTitle,
        description: enDescription,
        tags: enTags,
        videoPath: input.videoPath,
      },
      {
        platform: "x",
        title: `${input.jpScript.date} 世界ニューストップ3`,
        description: "",
        tags: ["#世界ニュース", "#DailyWorld60"],
        thread: ScriptOps.toXThread(input.jpScript),
      },
    ];

    const results: PublishingResult[] = [];
    for (const post of posts) {
      const publisher = this.publishers[post.platform];
      if (!publisher) {
        results.push({ platform: post.platform, ok: false, error: "No publisher configured" });
        continue;
      }
      try {
        const r = await publisher.publish(post, { dryRun: input.dryRun });
        results.push(r);
      } catch (e) {
        results.push({
          platform: post.platform,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  }

  private buildTitle(s: Script): string {
    return `Daily World 60 — ${s.date} | World News in Simple English`;
  }

  private buildDescription(s: Script): string {
    const lines: string[] = [
      `Today's top 3 world stories, simplified for English learners.`,
      ``,
      `Stories:`,
      ...s.stories.map(st => `${st.index}. ${st.country.flag} ${st.headline} (${st.sourceName})`),
      ``,
      `Today's word: ${s.todaysWord.word} — ${s.todaysWord.definitionEn}`,
      ``,
      `Follow for daily 60-second world news in simple English.`,
      ``,
      `#WorldNews #EnglishLearners #DailyWorld60 #ESL #Shorts`,
    ];
    return lines.join("\n");
  }

  private buildTags(s: Script): string[] {
    return [
      "World News",
      "English Learners",
      "ESL",
      "Daily News",
      "Shorts",
      "60 Seconds",
      ...s.stories.flatMap(st => [st.country.code]),
    ];
  }
}
