export type SWord = { w: string; t: number; d: number };
export type SMapMarker = {
  x: number; y: number; strike: boolean;
  label?: string; labelX?: number; labelY?: number;
};
export type SMap = { bg: string; markers: SMapMarker[] };
export type SChunk = {
  text: string;
  start: number;
  end: number;
  words: SWord[];
  bg: string | null;
  motion: string | null;
  firstOfCue: boolean;
};
export type STail = { text: string; start: number; end: number };
export type ShortVideo = {
  code: string;
  index: number;
  accent: string;
  country: { name: string; flag: string | null };
  headline: string;
  hookText: string;
  isShortHook: boolean;
  source: { name: string; url: string };
  audio: string;
  bgm: { file: string; offset: number; volume: number; conflict: boolean } | null;
  duration: number;
  hookEnd: number;
  hookBg: string | null;
  map: SMap | null;
  chunks: SChunk[];
  question: STail | null;
  outro: STail | null;
  date: string;
};
export type ShortProps = { date: string; fps: number; videos: ShortVideo[]; pick?: number };
