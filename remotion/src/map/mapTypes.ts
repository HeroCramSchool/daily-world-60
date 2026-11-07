/** docs/map-short.md の props-map.json と同じ形。prep-map.ts が書き、MapShort が読む。 */
export type MapLegendItem = {
  key: string;
  label: string;
  color: string;
};

export type MapShortProps = {
  fps: number;
  durationSec: number;
  title: string;
  shortTitle: string;
  cta: string;
  legend: MapLegendItem[];
  /** world-atlas の数値 id (ISO 3166-1 numeric, 3 桁ゼロ埋め) → legend.key */
  byNumeric: Record<string, string>;
  unknownLabel: string;
  sourceLine: string;
  brand: string;
  /** registry.json の補足 (publish-map.ts が説明文に載せる)。描画では使わない */
  descriptionNote?: string;
  /** ナレーション。無ければ無音の地図 */
  narration?: MapNarration;
};

export type MapNarrationWord = { w: string; t: number; d: number };

export type MapNarration = {
  /** public/ からの相対パス */
  audio: string;
  /** 音声を始める秒 */
  offsetSec: number;
  /** 文ごとの時刻 (音声の秒)。keys はその文で読む凡例の鍵、highlight はその文で名前を読む国の数値 id */
  lines: Array<{ text: string; start: number; end: number; words: MapNarrationWord[]; keys: string[]; highlight: string | null }>;
};
