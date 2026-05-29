import type { Region } from "../shared/Region.js";

export interface NewsCurationCriteria {
  /** 最終的に選びたい本数 */
  readonly targetCount: number;
  /** 候補のショートリスト最大数（LLM に渡す前段） */
  readonly shortlistSize: number;
  /** これより古いものは除外する（hours） */
  readonly recencyHours: number;
  /** 地域多様性を重視するか */
  readonly preferDiverseRegions: boolean;
  /** 強制除外するソースID */
  readonly excludeSourceIds: readonly string[];
  /** 強制除外する地域 */
  readonly excludeRegions: readonly Region[];
}

export const DEFAULT_CURATION_CRITERIA: NewsCurationCriteria = {
  targetCount: 3,
  shortlistSize: 30,
  recencyHours: 18,
  preferDiverseRegions: true,
  excludeSourceIds: [],
  excludeRegions: [],
};
