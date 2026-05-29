import type { Script } from "../../domain/script/Script.js";
import type { Thumbnail } from "../../domain/media/Thumbnail.js";

export interface ThumbnailGeneratorPort {
  generate(input: {
    script: Script;
    outputPath: string;
  }): Promise<Thumbnail>;
}
