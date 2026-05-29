import type { Script } from "../../domain/script/Script.js";
import type { Thumbnail } from "../../domain/media/Thumbnail.js";
import type { ThumbnailGeneratorPort } from "../../application/ports/ThumbnailGeneratorPort.js";

/**
 * TODO: Efecto Skill 経由の本実装に差し替え予定。
 * 現時点ではフォールバックとして単色背景＋テキストの HTML→Playwright スクショで作る。
 * まずは「サムネ未生成でも他工程が動く」スタブとして空ファイルを返す。
 */
export class StubThumbnailGenerator implements ThumbnailGeneratorPort {
  async generate(input: {
    script: Script;
    outputPath: string;
  }): Promise<Thumbnail> {
    // 実装は後続フェーズで Efecto MCP / Playwright HTML に置き換える
    console.warn(`[thumbnail] STUB: outputPath=${input.outputPath} not generated yet`);
    return {
      filePath: input.outputPath,
      width: 1280,
      height: 720,
      format: "png",
    };
  }
}
