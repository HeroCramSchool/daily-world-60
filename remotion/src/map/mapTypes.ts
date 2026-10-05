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
};
