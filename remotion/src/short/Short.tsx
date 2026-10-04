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
  // top は 0 フレーム目がサムネ代わりなので国旗チップも即時表示 (legacy は従来のフェードイン)
  const chipIn = v.hookLayout === "top" ? 1 : interpolate(local, [2, 12], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const hookSizes = v.isShortHook ? [120, 110, 100, 92, 84, 76, 68, 60, 52] : [76, 68, 62, 56, 50, 46, 42, 38, 34];
  // fit.ts の字幅見積は Inter Black より狭く、5語以上だと実行数が1行増えて箱をはみ出す (レビュー実測)。
  // top は上端固定で下へ伸びるので、5語以上は 110 から始めて余裕を作る。
  const topSizes = v.hookText.split(/\s+/).filter(Boolean).length >= 5 ? hookSizes.filter(s => s <= 110) : hookSizes;
  return (
    <AbsoluteFill>
      <Backplate bg={v.hookBg} motion={null} local={local} fadeIn={false} fps={fps} />
      <Scrim variant={v.hookLayout === "top" ? "hookTop" : "hook"} />
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

      {v.hookLayout === "top" ? (
        // A/B "top": 見出しを上段に置き 0 フレーム目から全文を出す。フィードでは最初の 1 秒が
        // サムネ代わりで、下段 (y 1400〜) は Shorts の右レール・題名帯に隠れる。
        <div style={{ position: "absolute", left: 60, right: 60, top: 240, height: 620 }}>
          <BigText
            text={v.hookText}
            local={local}
            fps={fps}
            boxW={960}
            boxH={620}
            maxSize={topSizes}
            instant
            accentFirstToken
            accent={v.accent}
          />
          <div style={{ display: "flex", gap: 16, marginTop: 28 }}>
            <HookChip accent={v.accent}>{fmtDate(v.date)}</HookChip>
            {v.source.name ? <HookChip accent={v.accent}>{v.source.name}</HookChip> : null}
          </div>
        </div>
      ) : (
        <div style={{ position: "absolute", left: 60, right: 60, top: 980, height: 660, display: "flex", alignItems: "flex-end" }}>
          <BigText
            text={v.hookText}
            local={local - 6}
            fps={fps}
            boxW={960}
            boxH={660}
            maxSize={hookSizes}
          />
        </div>
      )}

      <SourceFooter name={v.source.name} url={v.source.url} />
    </AbsoluteFill>
  );
};

/** "top" レイアウトで見出しの下に出す小さな札 (日付・出典)。字幕箱と同じ accent の左バー。 */
const HookChip: React.FC<{ accent: string; children: React.ReactNode }> = ({ accent, children }) => (
  <div
    style={{
      position: "relative", display: "flex", alignItems: "center", height: 56, maxWidth: 600,
      padding: "0 22px 0 26px", borderRadius: 12, background: "rgba(10,10,10,.78)", overflow: "hidden",
    }}
  >
    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, background: accent }} />
    <div style={{ fontWeight: 800, fontSize: 30, color: "#fff", letterSpacing: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {children}
    </div>
  </div>
);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-04" → "Oct 4, 2026"。ISO 日付でなければそのまま。 */
const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
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
