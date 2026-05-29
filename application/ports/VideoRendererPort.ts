import type { Audio } from "../../domain/media/Audio.js";
import type { Video } from "../../domain/media/Video.js";
import type { Script } from "../../domain/script/Script.js";
import type { BRollClip } from "./BRollFetcherPort.js";

export interface VideoRendererPort {
  render(input: {
    script: Script;
    audio: Audio;
    brollClips: readonly BRollClip[];
    outputPath: string;
    /** 9:16 縦動画 */
    width?: number;
    height?: number;
  }): Promise<Video>;
}
