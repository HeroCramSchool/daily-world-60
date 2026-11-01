import type { FetchedDoc, Storyboard } from "../../domain/storyboard/Storyboard.js";
import type { ExplainerStatus } from "../../domain/storyboard/ExplainerArm.js";

/** Routine が選んだ1本。解説形式の台本作りの入力。 */
export type DeskStory = {
  date: string;
  index: number;
  countryCode: string;
  countryName?: string;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl?: string;
  /** Routine の mapMarkers の地名。 */
  places?: string[];
};

export type DeskResult = {
  status: ExplainerStatus;
  /** status が ok のときだけ。照合と反証を通ったもの。 */
  storyboard?: Storyboard;
  docs: FetchedDoc[];
  errors: string[];
  costUsd: number;
};

/**
 * 1本のニュースを調べ、取得したページの文だけで解説形式の台本を書き、照合・反証を通す。
 * 失敗はすべて status で返す（呼ぶ側は今の形式で描く）。
 */
export interface NewsDeskPort {
  write(story: DeskStory): Promise<DeskResult>;
}
