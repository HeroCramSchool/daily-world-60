export interface VoiceProfile {
  readonly id: string; // e.g. "en-US-AvaNeural"
  readonly languageCode: string; // BCP-47
  readonly gender: "female" | "male";
  readonly rate: string; // edge-tts rate, e.g. "+5%"
  readonly pitch: string; // edge-tts pitch, e.g. "+0Hz"
}

export const DEFAULT_EN_VOICE: VoiceProfile = {
  id: "en-US-AvaNeural",
  languageCode: "en-US",
  gender: "female",
  rate: "+5%",
  pitch: "+0Hz",
};
