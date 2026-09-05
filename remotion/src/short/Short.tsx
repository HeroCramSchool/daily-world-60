import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { Backplate, Scrim, TopStripe, SourceFooter, Headline, CountryLine, W } from "./Chrome";
import { Caption, BigText } from "./Caption";
import { EyeCatch, EYECATCH_SEC } from "./EyeCatch";
import { MapScene } from "./MapScene";
import type { ShortProps, ShortVideo, SChunk } from "../lib/shortTypes";

const f = (sec: number, fps: number) => Math.max(1, Math.round(sec * fps));

export function pickVideo(p: ShortProps): ShortVideo | null {
  const i = p.pick ?? 0;
  return p.videos?.[i] ?? p.videos?.[0] ?? null;
}

export const totalShortFrames = (p: ShortProps, fps: number) => {
  const v = pickVideo(p);
  return v ? f(v.duration + EYECATCH_SEC, fps) : fps;
};

/**
 * フックの直後にアイキャッチを挟むため、ナレーションを hookEnd で2つに割り、
 * 後半をアイキャッチの尺だけ後ろへずらす。字幕は音声時間で同期しているので、
 * ずらした分 (audioOffset) を引いて元の単語タイムスタンプと合わせる。
 */
export const Short: React.FC<ShortProps> = (props) => {
  const { fps } = useVideoConfig();
  const v = pickVideo(props);
  if (!v) return <AbsoluteFill style={{ background: "#0A0A0A" }} />;

  const hookFrames = f(v.hookEnd, fps);
  const eyeFrames = f(EYECATCH_SEC, fps);
  const shift = eyeFrames;                 // フレーム
  const offsetSec = shift / fps;           // 秒 (字幕同期の補正に使う)
  const at = (sec: number) => f(sec, fps) + shift;

  return (
    <AbsoluteFill style={{ background: "#0A0A0A", fontFamily: FONT }}>
      {/* ナレーション前半 (フック) */}
      <Sequence durationInFrames={hookFrames} name="voice-hook">
        <Audio src={staticFile(v.audio)} trimAfter={hookFrames} />
      </Sequence>
      {/* ナレーション後半 (本文以降) — アイキャッチのぶん後ろへ */}
      <Sequence from={hookFrames + eyeFrames} name="voice-body">
        <Audio src={staticFile(v.audio)} trimBefore={hookFrames} />
      </Sequence>

      <Sequence durationInFrames={hookFrames} name="hook">
        <HookScene v={v} />
      </Sequence>

      <Sequence from={hookFrames} durationInFrames={eyeFrames} name="eyecatch">
        <EyeCatch accent={v.accent} />
      </Sequence>

      {v.chunks.map((c, i) => {
        const from = at(c.start);
        const next = v.chunks[i + 1];
        const endSec = next ? next.start : (v.question?.start ?? v.outro?.start ?? v.duration);
        return (
          <Sequence key={i} from={from} durationInFrames={Math.max(1, at(endSec) - from)} name={`body-${i + 1}`}>
            <BodyScene v={v} chunk={c} absFrom={from} audioOffset={offsetSec} isFirstBody={i === 0} />
          </Sequence>
        );
      })}

      {v.question && (
        <Sequence from={at(v.question.start)} durationInFrames={Math.max(1, at(v.outro?.start ?? v.duration) - at(v.question.start))} name="question">
          <QuestionScene v={v} />
        </Sequence>
      )}

      {v.outro && (
        <Sequence from={at(v.outro.start)} durationInFrames={Math.max(1, at(v.duration) - at(v.outro.start))} name="outro">
          <OutroScene v={v} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

const HookScene: React.FC<{ v: ShortVideo }> = ({ v }) => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chipIn = interpolate(local, [2, 12], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <Backplate bg={v.hookBg} motion={null} local={local} fadeIn={false} fps={fps} />
      <Scrim variant="hook" />
      <TopStripe />

      <div
        style={{
          position: "absolute", left: 60, top: 110, height: 96, borderRadius: 14,
          background: "rgba(10,10,10,.78)", display: "flex", alignItems: "center", gap: 24,
          padding: "0 28px", maxWidth: W - 120,
          opacity: chipIn, transform: `translateX(${(1 - chipIn) * -24}px)`,
        }}
      >
        {v.country.flag && <Img src={staticFile(v.country.flag)} style={{ width: 96, height: 60, objectFit: "contain" }} />}
        <div style={{ fontWeight: 900, fontSize: 40, color: "#fff", letterSpacing: 1, whiteSpace: "nowrap" }}>{v.country.name}</div>
      </div>

      <div style={{ position: "absolute", left: 60, right: 60, top: 980, height: 660, display: "flex", alignItems: "flex-end" }}>
        <BigText
          text={v.hookText}
          local={local - 6}
          fps={fps}
          boxW={960}
          boxH={660}
          maxSize={v.isShortHook ? [120, 110, 100, 92, 84, 76, 68, 60, 52] : [76, 68, 62, 56, 50, 46, 42, 38, 34]}
        />
      </div>

      <SourceFooter name={v.source.name} url={v.source.url} />
    </AbsoluteFill>
  );
};

const BodyScene: React.FC<{ v: ShortVideo; chunk: SChunk; absFrom: number; audioOffset: number; isFirstBody: boolean }> = ({ v, chunk, absFrom, audioOffset, isFirstBody }) => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = (absFrom + local) / fps - audioOffset;
  // 地図は本文の最初の 1 シーンだけ (本番の build-news-video.ts と同じ約束)
  const useMap = isFirstBody && v.map !== null;
  return (
    <AbsoluteFill>
      {/* 画の切り替わりに whoosh を置く。素材は ffmpeg 合成なので Content ID の心配が無い */}
      {chunk.firstOfCue && <Audio src={staticFile("sfx/whoosh.mp3")} volume={0.4} />}
      {useMap
        ? <MapScene bg={v.map!.bg} markers={v.map!.markers} accent={v.accent} appear />
        : <Backplate bg={chunk.bg} motion={chunk.motion} local={local} fadeIn={chunk.firstOfCue} fps={fps} />}
      <Scrim variant={useMap ? "map" : "body"} />
      <TopStripe />
      <CountryLine name={v.country.name} accent={v.accent} />
      <Headline text={v.headline} />
      <Caption words={chunk.words} time={time} local={local} accent={v.accent} fps={fps} />
      <SourceFooter name={v.source.name} url={v.source.url} />
    </AbsoluteFill>
  );
};

const QuestionScene: React.FC<{ v: ShortVideo }> = ({ v }) => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bar = interpolate(local, [0, 14], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0A0A0A" }}>
      <Backplate bg={v.hookBg} motion={null} local={local} fadeIn fps={fps} />
      <AbsoluteFill style={{ background: "rgba(10,10,10,.86)" }} />
      <TopStripe />
      <div style={{ position: "absolute", left: 60, top: 700, width: 300, height: 12, background: v.accent, borderRadius: 6, transform: `scaleX(${bar})`, transformOrigin: "left" }} />
      <div style={{ position: "absolute", left: 60, right: 60, top: 780, height: 700 }}>
        <BigText text={v.question!.text} local={local} fps={fps} boxW={960} boxH={640} maxSize={[104, 92, 84, 76, 68, 60]} />
      </div>
      <SourceFooter name={v.source.name} url={v.source.url} />
    </AbsoluteFill>
  );
};

const OutroScene: React.FC<{ v: ShortVideo }> = ({ v }) => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Backplate bg={v.hookBg} motion={null} local={local} fadeIn fps={fps} />
      <Scrim variant="hook" />
      <TopStripe />
      <CountryLine name={v.country.name} accent={v.accent} />
      <div style={{ position: "absolute", left: 60, right: 60, top: 1000, height: 620, display: "flex", alignItems: "flex-end" }}>
        <BigText text={v.outro!.text} local={local} fps={fps} boxW={960} boxH={620} maxSize={[84, 76, 68, 60, 54, 48]} />
      </div>
      <SourceFooter name={v.source.name} url={v.source.url} />
    </AbsoluteFill>
  );
};
