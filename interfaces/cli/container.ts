import * as path from "node:path";
import * as fs from "node:fs/promises";
import "dotenv/config";

import type { NewsSource } from "../../domain/news/NewsSource.js";
import type { Platform } from "../../domain/publishing/Platform.js";
import type { PublisherPort } from "../../application/ports/PublisherPort.js";

import { RssNewsRepository } from "../../infrastructure/rss/RssNewsRepository.js";
import { ClaudeApiClient } from "../../infrastructure/claude/ClaudeApiClient.js";
import { ClaudeCliClient } from "../../infrastructure/claude/ClaudeCliClient.js";
import { EdgeTtsClient } from "../../infrastructure/tts/EdgeTtsClient.js";
import type { ClaudeApiPort } from "../../application/ports/ClaudeApiPort.js";
import { PexelsBRollFetcher } from "../../infrastructure/pexels/PexelsBRollFetcher.js";
import { FfmpegVideoRenderer } from "../../infrastructure/ffmpeg/FfmpegVideoRenderer.js";
import { SkillBasedThumbnailGenerator } from "../../infrastructure/thumbnail/SkillBasedThumbnailGenerator.js";
import { SkillBasedYoutubePublisher } from "../../infrastructure/youtube/SkillBasedYoutubePublisher.js";
import { SkillBasedInstagramPublisher } from "../../infrastructure/instagram/SkillBasedInstagramPublisher.js";
import { SkillBasedTikTokPublisher } from "../../infrastructure/tiktok/SkillBasedTikTokPublisher.js";
import { SkillBasedXPublisher } from "../../infrastructure/x/SkillBasedXPublisher.js";

import { FetchNewsUseCase } from "../../application/usecases/FetchNewsUseCase.js";
import { CurateAndGenerateScriptUseCase } from "../../application/usecases/CurateAndGenerateScriptUseCase.js";
import { TranslateToJapaneseUseCase } from "../../application/usecases/TranslateToJapaneseUseCase.js";
import { SynthesizeAudioUseCase } from "../../application/usecases/SynthesizeAudioUseCase.js";
import { PublishAllUseCase } from "../../application/usecases/PublishAllUseCase.js";
import { RunDailyPipelineUseCase } from "../../application/usecases/RunDailyPipelineUseCase.js";

/**
 * 合成ルート (Composition Root)。
 * すべての具象実装をここで配線し、CLI からはこれだけ呼ぶ。
 */
export async function buildContainer() {
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const outputRoot = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.join(rootDir, "output");

  // sources
  const feedsPath = path.join(rootDir, "config", "rss-feeds.json");
  const feedsJson = JSON.parse(await fs.readFile(feedsPath, "utf-8"));
  const sources: NewsSource[] = feedsJson.sources;

  // infra
  const newsRepo = new RssNewsRepository();
  // CLAUDE_MODE: "cli"（claude -p、APIキー不要、Pro サブスク経由）/ "api"（ANTHROPIC_API_KEY 必要）
  const claudeMode = (process.env.CLAUDE_MODE ?? "cli").toLowerCase();
  const claude: ClaudeApiPort =
    claudeMode === "api"
      ? new ClaudeApiClient()
      : new ClaudeCliClient({ cwd: rootDir });
  const tts = new EdgeTtsClient({ binary: process.env.EDGE_TTS_BIN });
  const broll = process.env.PEXELS_API_KEY
    ? new PexelsBRollFetcher(process.env.PEXELS_API_KEY)
    : undefined;
  const renderer = new FfmpegVideoRenderer();
  const thumbnail = new SkillBasedThumbnailGenerator({ cwd: rootDir });
  const publishers: Record<Platform, PublisherPort | undefined> = {
    youtube: new SkillBasedYoutubePublisher({ cwd: rootDir }),
    instagram: new SkillBasedInstagramPublisher({ cwd: rootDir }),
    tiktok: new SkillBasedTikTokPublisher({ cwd: rootDir }),
    x: new SkillBasedXPublisher({ cwd: rootDir }),
  };

  // usecases
  const fetchNews = new FetchNewsUseCase(newsRepo);
  const curate = new CurateAndGenerateScriptUseCase(claude);
  const translate = new TranslateToJapaneseUseCase(claude);
  const synthesizeAudio = new SynthesizeAudioUseCase(tts);
  const publishAll = new PublishAllUseCase(publishers);
  const runPipeline = new RunDailyPipelineUseCase({
    fetchNews,
    curate,
    translate,
    synthesizeAudio,
    publishAll,
  });

  return {
    rootDir,
    outputRoot,
    sources,
    fetchNews,
    curate,
    translate,
    synthesizeAudio,
    publishAll,
    runPipeline,
    renderer,
    thumbnail,
    broll,
  };
}

export type Container = Awaited<ReturnType<typeof buildContainer>>;
