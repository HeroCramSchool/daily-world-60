import type { Audio } from "../../domain/media/Audio.js";
import type { VoiceProfile } from "../../domain/media/VoiceProfile.js";

export interface TTSPort {
  synthesize(input: {
    text: string;
    voice: VoiceProfile;
    outputPath: string;
  }): Promise<Audio>;
}
