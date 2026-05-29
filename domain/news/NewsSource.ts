import type { Region } from "../shared/Region.js";

export type Reliability = "high" | "medium" | "low";

export interface NewsSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly rssUrl: string;
  readonly region: Region;
  readonly country: string;
  readonly language: "en";
  readonly reliability: Reliability;
}
