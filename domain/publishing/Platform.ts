import type { Language } from "../shared/Language.js";

export type Platform = "youtube" | "instagram" | "tiktok" | "x";

export const Platform = {
  YOUTUBE: "youtube" as Platform,
  INSTAGRAM: "instagram" as Platform,
  TIKTOK: "tiktok" as Platform,
  X: "x" as Platform,

  languageOf(p: Platform): Language {
    return p === "x" ? "jp" : "en";
  },

  acceptsVideo(p: Platform): boolean {
    return p !== "x";
  },

  acceptsThread(p: Platform): boolean {
    return p === "x";
  },
};
