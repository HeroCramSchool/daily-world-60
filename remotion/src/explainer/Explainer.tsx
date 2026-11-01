import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT } from "../lib/theme";
import { Scrim, TopStripe, SourceFooter, CountryLine } from "../short/Chrome";
import { Caption } from "../short/Caption";
import { HookCard } from "./HookCard";
import { MapZoom } from "./MapZoom";
import { Counter } from "./Counter";
import { Bars } from "./Bars";
import { Route } from "./Route";
import { QuoteCard } from "./QuoteCard";
import { Stage, easeOut, NAVY } from "./Stage";
import type { ExplainerVideo, XBeat, XVisual } from "../lib/explainerTypes";

export type ExplainerProps = { fps: number; video: ExplainerVideo };

const TRANS_F = 6;
const LOOP_SEC = 0.6;
const WHOOSH_F = 15;

export const explainerFrames = (v: ExplainerVideo, fps: number) => Math.max(1, Math.round(v.duration * fps));

type Seg = { beat: XBeat; from: number; to: number };

/** 文ごとの図の区間 (フレーム)。1 つ目は 0 フレーム目から、最後はループの戻りの手前まで。 */
function segmentsOf(beats: XBeat[], fps: number, loopStart: number): Seg[] {
  const out: Seg[] = [];
  for (const [i, b] of beats.entries()) {
    const prev = out[out.length - 1];
    const from = prev ? Math.max(prev.from + 1, Math.round(b.start * fps)) : 0;
    if (prev && from >= loopStart) break;
    if (prev) prev.to = from;
    out.push({ beat: b, from, to: loopStart });
  }
  return out;
}

const VisualView: React.FC<{ visual: XVisual; accent: string; local: number; span: number; instant: boolean }> = ({
  visual, accent, local, span, instant,
}) => {
  switch (visual?.kind) {
    case "map_zoom": return <MapZoom visual={visual} local={local} span={span} instant={instant} />;
    case "route": return <Route visual={visual} local={local} span={span} instant={instant} accent={accent} />;
    case "counter": return <Counter visual={visual} local={local} instant={instant} accent={accent} />;
    case "bars": return <Bars visual={visual} local={local} instant={instant} accent={accent} />;
    case "quote_card": return <QuoteCard visual={visual} local={local} instant={instant} accent={accent} />;
    default: return <Stage />;
  }
};

/** 切り替えの入り。新しい図を古い図の上に 6 フレームで重ねる (下の図は残すので紺地へ沈まない)。 */
const Layer: React.FC<{ p: number; children: React.ReactNode }> = ({ p, children }) => (
  <AbsoluteFill style={{ opacity: p, transform: p < 1 ? `scale(${1.04 - 0.04 * p})` : undefined }}>{children}</AbsoluteFill>
);

/**
 * 解説型ショート。音声は1本のまま流し (アイキャッチで割らない)、文ごとに図を切り替える。
 * 0 フレーム目はフィードのサムネ代わりなので、見出しと 1 つ目の図を出し切った状態で始める。
 * 最後の約 0.6 秒で同じ状態へ戻し、ループの継ぎ目を消す。
 */
export const Explainer: React.FC<{ v: ExplainerVideo }> = ({ v }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: total } = useVideoConfig();
  const loopF = Math.round(LOOP_SEC * fps);
  const loopStart = Math.max(1, total - loopF);
  const segs = segmentsOf(v.beats ?? [], fps, loopStart);

  let k = 0;
  for (let i = 0; i < segs.length; i++) if (segs[i].from <= frame) k = i;
  const cur = segs[k];
  const inLoop = segs.length > 0 && frame >= loopStart;
  const loopP = inLoop ? easeOut(frame, loopStart, TRANS_F) : 0;
  const curP = k === 0 ? 1 : easeOut(frame, cur.from, TRANS_F);

  const view = (i: number, local: number, instant: boolean) => (
    <VisualView visual={segs[i].beat.visual} accent={v.accent} local={local} span={segs[i].to - segs[i].from} instant={instant} />
  );

  // 見出し: 1 つ目の文の間と戻りは hero、それ以外は compact。大小が重なると二重に見えるので、
  // 切り替えの前半で古い方を消し、後半で新しい方を出す
  const half = TRANS_F / 2;
  const second = segs[1]?.from ?? Infinity;
  const swap = inLoop ? loopStart : second;
  const outP = easeOut(frame, swap, half);
  const inP = easeOut(frame, swap + half, half);
  const heroO = segs.length < 2 ? 1 : inLoop ? inP : 1 - outP;
  const compactO = segs.length < 2 ? 0 : inLoop ? 1 - outP : inP;

  // 字幕: その文の頭から次の文の頭まで。最後の文は戻りの手前まで (語がまだ続くならその終わりまで)
  const capSeg = segs.findIndex((s, i) => {
    const next = segs[i + 1];
    const lastEnd = Math.ceil((s.beat.end ?? 0) * fps);
    const until = next ? next.from : Math.min(total, Math.max(loopStart, lastEnd));
    return frame >= s.from && frame < until;
  });
  const capBeat = capSeg >= 0 ? segs[capSeg] : null;

  const footer = (inLoop ? segs[0] : cur)?.beat.sourceName ?? v.source?.name ?? "";

  return (
    <AbsoluteFill style={{ background: NAVY, fontFamily: FONT }}>
      <Audio src={staticFile(v.audio)} />
      {segs.slice(1).map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={WHOOSH_F} name={`whoosh-${i + 2}`}>
          <Audio src={staticFile("sfx/whoosh.mp3")} volume={0.4} />
        </Sequence>
      ))}

      {segs.length === 0 ? <Stage /> : (
        <>
          {k > 0 && curP < 1 && <Layer p={1}>{view(k - 1, frame - segs[k - 1].from, k - 1 === 0)}</Layer>}
          {loopP < 1 && <Layer p={curP}>{view(k, frame - cur.from, k === 0)}</Layer>}
          {inLoop && <Layer p={loopP}>{view(0, 0, true)}</Layer>}
        </>
      )}

      <Scrim variant="map" />
      <TopStripe />
      <CountryLine name={v.country.name} accent={v.accent} />
      <HookCard text={v.hook} accent={v.accent} mode="hero" opacity={heroO} fps={fps} />
      <HookCard text={v.hook} accent={v.accent} mode="compact" opacity={compactO} fps={fps} />
      {capBeat && capBeat.beat.words?.length > 0 && (
        <Caption words={capBeat.beat.words} time={frame / fps} local={frame - capBeat.from} accent={v.accent} fps={fps} />
      )}
      <SourceFooter name={footer} url="" />
    </AbsoluteFill>
  );
};

export const ExplainerPreview: React.FC<ExplainerProps> = ({ video }) => <Explainer v={video} />;
