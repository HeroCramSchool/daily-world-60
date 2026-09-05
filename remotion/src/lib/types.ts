export type Source = { name: string; url: string }
export type Word = { t: number; d: number; w: string }
export type Line = { start: number; end: number; text: string }
export type CalloutKind = "percent" | "currency" | "delta" | "plain";
export type Callout = {
  t: number;
  end: number;
  label: string;
  kind: CalloutKind;
  display: string;
  from?: string;
  value: number;
}
export type Segment = {
  kind: "hook" | "section" | "outro";
  index: number;
  heading: string;
  audio: string;
  durationSec: number;
  words: Word[];
  lines: Line[];
  bg: string | null;
  source: Source | null;
  callouts: Callout[];
}
export type LongformProps = {
  date: string;
  title: string;
  topic: string;
  fps: number;
  segments: Segment[];
  bgm?: string | null;
  bgmDurationSec?: number;
}
