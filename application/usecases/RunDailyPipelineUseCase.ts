import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { NewsSource } from "../../domain/news/NewsSource.js";
import type { NewsCurationCriteria } from "../../domain/news/NewsCurationCriteria.js";
import type { Script } from "../../domain/script/Script.js";
import type { FetchNewsUseCase } from "./FetchNewsUseCase.js";
import type { CurateAndGenerateScriptUseCase } from "./CurateAndGenerateScriptUseCase.js";
import type { TranslateToJapaneseUseCase } from "./TranslateToJapaneseUseCase.js";
import type { SynthesizeAudioUseCase } from "./SynthesizeAudioUseCase.js";
import type { PublishAllUseCase } from "./PublishAllUseCase.js";

export interface PipelineResult {
  date: string;
  outputDir: string;
  enScript: Script;
  jpScript: Script;
  publishResults?: unknown[];
}

/**
 * 1日分のパイプラインを実行する Orchestrator。
 * stage は段階別の usecase に委譲し、ここは順序と保存のみを管理する。
 */
export class RunDailyPipelineUseCase {
  constructor(
    private readonly deps: {
      fetchNews: FetchNewsUseCase;
      curate: CurateAndGenerateScriptUseCase;
      translate: TranslateToJapaneseUseCase;
      synthesizeAudio?: SynthesizeAudioUseCase;
      publishAll?: PublishAllUseCase;
    },
  ) {}

  async execute(input: {
    sources: readonly NewsSource[];
    criteria: NewsCurationCriteria;
    outputRoot: string;
    date?: string; // YYYY-MM-DD, default = today UTC
    skipAudio?: boolean;
    skipPublish?: boolean;
    dryRun?: boolean;
  }): Promise<PipelineResult> {
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const outputDir = path.join(input.outputRoot, date);
    await fs.mkdir(outputDir, { recursive: true });

    // 1. Fetch
    const articles = await this.deps.fetchNews.execute({
      sources: input.sources,
      options: { sinceHours: input.criteria.recencyHours, perSourceLimit: 8 },
    });
    await fs.writeFile(
      path.join(outputDir, "articles.json"),
      JSON.stringify(articles, null, 2),
      "utf-8",
    );

    // 2. Curate + script (en)
    const enScript = await this.deps.curate.execute({
      articles,
      criteria: input.criteria,
      date,
    });
    await fs.writeFile(
      path.join(outputDir, "script-en.json"),
      JSON.stringify(enScript, null, 2),
      "utf-8",
    );

    // 3. Translate (jp for X)
    const jpScript = await this.deps.translate.execute(enScript);
    await fs.writeFile(
      path.join(outputDir, "script-jp.json"),
      JSON.stringify(jpScript, null, 2),
      "utf-8",
    );

    // 4. Audio (skip可)
    if (!input.skipAudio && this.deps.synthesizeAudio) {
      await this.deps.synthesizeAudio.execute({
        script: enScript,
        outputPath: path.join(outputDir, "voice.mp3"),
      });
    }

    // 5. Publish (skip可、未実装のものは PublishAll 側で扱う)
    let publishResults: unknown[] | undefined;
    if (!input.skipPublish && this.deps.publishAll) {
      publishResults = await this.deps.publishAll.execute({
        enScript,
        jpScript,
        videoPath: path.join(outputDir, "final.mp4"),
        thumbnailPath: path.join(outputDir, "thumbnail.png"),
        dryRun: input.dryRun,
      });
    }

    return { date, outputDir, enScript, jpScript, publishResults };
  }
}
