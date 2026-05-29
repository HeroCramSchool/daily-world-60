import type { Country } from "../shared/Country.js";

/**
 * 動画/Xスレッドに登場する 1ストーリー単位。
 * 元ニュース記事から ESL 平易化 / 日本語化された後の最終形。
 */
export interface Story {
  readonly index: number; // 1, 2, 3
  readonly country: Country;
  readonly headline: string;
  readonly summary: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
}
