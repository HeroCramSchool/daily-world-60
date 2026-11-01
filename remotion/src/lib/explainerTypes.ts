import type { SWord } from "./shortTypes";

/** 地図の上の点。x, y は 1080×1920 の画素。 */
export type XPoint = { x: number; y: number; label: string };

export type XVisual =
  | { kind: "map_zoom"; bg: string; points: XPoint[] }
  | { kind: "counter"; value: number; label: string }
  | { kind: "bars"; items: Array<{ label: string; value: number }> }
  | { kind: "route"; bg: string; from: XPoint; to: XPoint }
  | { kind: "quote_card"; who: string; text: string };

/** 台本の1文。start/end は音声の秒、words はその文の単語。 */
export type XBeat = {
  id: string;
  start: number;
  end: number;
  words: SWord[];
  visual: XVisual;
  /** その文の出典の報道機関（framing の文は直前の fact の出典）。 */
  sourceName: string;
};

export type ExplainerVideo = {
  style: "explainer";
  code: string;
  index: number;
  accent: string;
  country: { name: string; flag: string | null };
  /** 画面の見出し。0 フレーム目から全文を出す。 */
  hook: string;
  audio: string;
  bgm: { file: string; offset: number; volume: number; conflict: boolean } | null;
  /** 動画の尺（秒）。音声の尺に末尾の余白を足したもの。 */
  duration: number;
  beats: XBeat[];
  source: { name: string; url: string };
  date: string;
};
