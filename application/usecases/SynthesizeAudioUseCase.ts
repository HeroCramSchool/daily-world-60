import type { Audio } from "../../domain/media/Audio.js";
import { DEFAULT_EN_VOICE } from "../../domain/media/VoiceProfile.js";
import type { VoiceProfile } from "../../domain/media/VoiceProfile.js";
import { Script } from "../../domain/script/Script.js";
import type { TTSPort } from "../ports/TTSPort.js";

export class SynthesizeAudioUseCase {
  constructor(private readonly tts: TTSPort) {}

  async execute(input: {
    script: Script;
    outputPath: string;
    voice?: VoiceProfile;
  }): Promise<Audio> {
    if (input.script.language !== "en") {
      throw new Error("Audio synthesis is only for 'en' scripts");
    }
    const narration = Script.toNarration(input.script);
    return this.tts.synthesize({
      text: narration,
      voice: input.voice ?? DEFAULT_EN_VOICE,
      outputPath: input.outputPath,
    });
  }
}
