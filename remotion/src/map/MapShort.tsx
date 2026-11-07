import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Easing, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT, T } from "../lib/theme";
import { EM, wrapText } from "../lib/fit";
import { worldPaths } from "./world";
import type { MapNarration, MapShortProps } from "./mapTypes";

/**
 * 「各国の○○」塗り分け地図 1 枚 (1080×1920・5〜9 秒・narration があれば読み終わるまで)。
 * 0〜1.2 秒でカテゴリ順に塗りが入り、以後は静止 (ループ前提)。
 * narration があるときは、地図と凡例の間に字幕を出し、その文で読む凡例のチップと国を光らせる。
 * 下 320px は Shorts の UI が被るので、本文は y=1600 より上に収める。
 */
const W = 1080;
const UNKNOWN_FILL = "#2A3550";
const BORDER = "#0B1430";
const FILL_START = 6;   // category 0 の塗り開始フレーム
const FILL_STEP = 8;    // category ごとのずれ
const FILL_LEN = 12;    // 1 category の塗りにかけるフレーム
const CTA_AT_SEC = 1.5;
const ZOOM_END = 1;  // 全尺でかける微ズーム (ほぼ静止)

// 凡例チップ: 行数を字幅見積もりで数え、3 行に伸びたら CTA を下げる (出典行 y=1700 は固定)
const LEGEND_TOP = 1350;
const LEGEND_W = 960;
const LEGEND_GAP = 16;
const CHIP_H = 64;
const CHIP_FONT = 32;
const COUNT_FONT = 28;
const chipWidth = (label: string, n: number) =>
  2 + 16 + 34 + 14 + EM(label) * CHIP_FONT + 14 + EM(String(n)) * COUNT_FONT + 22 + 2;
function legendRows(chips: Array<{ label: string; n: number }>): number {
  let rows = 1;
  let x = 0;
  for (const c of chips) {
    const w = chipWidth(c.label, c.n);
    if (x > 0 && x + LEGEND_GAP + w > LEGEND_W) { rows += 1; x = w; }
    else x = x > 0 ? x + LEGEND_GAP + w : w;
  }
  return rows;
}

const TITLE_SIZES = [104, 96, 88, 80, 72, 64, 58];

// 字幕は地図の下端 (y≈1205) と凡例 (LEGEND_TOP) の間に 2 行まで。字幅の見積もりは Inter 900 より狭いので幅に余裕を残す
const CAPTION_TOP = 1218;
const CAPTION_SIZES = [40, 36, 32];
const CAPTION_FIT_W = 860;
const CAPTION_HOLD_SEC = 0.6;

/** いま読んでいる文。次の文が始まるか、読み終わって少し経つまで出す。 */
function currentLine(n: MapNarration | undefined, sec: number) {
  if (!n) return null;
  const t = sec - n.offsetSec;
  for (let i = n.lines.length - 1; i >= 0; i--) {
    const l = n.lines[i];
    if (t >= l.start) return t < l.end + CAPTION_HOLD_SEC || i < n.lines.length - 1 ? { line: l, t } : null;
  }
  return null;
}

function fitTitle(text: string): { fontSize: number; lines: string[] } {
  for (const fontSize of TITLE_SIZES) {
    const lines = wrapText(text, 960, fontSize, 2);
    if (lines) return { fontSize, lines };
  }
  for (const fontSize of [64, 58]) {
    const lines = wrapText(text, 960, fontSize, 3);
    if (lines) return { fontSize, lines };
  }
  return { fontSize: 58, lines: [text] };
}

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const MapShort: React.FC<MapShortProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const world = worldPaths();
  const title = useMemo(() => fitTitle(props.title.toUpperCase()), [props.title]);

  const legendKeys = useMemo(() => new Set(props.legend.map((l) => l.key)), [props.legend]);
  const keyOf = (id: string | null) => {
    if (id === null) return null;
    const k = props.byNumeric[id];
    return k !== undefined && legendKeys.has(k) ? k : null;
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of props.legend) c[l.key] = 0;
    for (const k of Object.values(props.byNumeric)) if (k in c) c[k] += 1;
    return c;
  }, [props.legend, props.byNumeric]);
  // id 無し (N. Cyprus / Somaliland / Kosovo) は灰色で描くが「No data」には数えない
  const unknownCount = world.countries.filter((c) => c.id !== null && keyOf(c.id) === null).length;

  const categoryT = (k: number) =>
    interpolate(frame, [FILL_START + FILL_STEP * k, FILL_START + FILL_STEP * k + FILL_LEN], [0, 1], {
      ...clamp, easing: Easing.out(Easing.cubic),
    });
  const unknownIdx = props.legend.length;
  const chips = [
    ...props.legend.map((l, k) => ({ ...l, n: counts[l.key] ?? 0, k })),
    ...(unknownCount > 0 ? [{ key: "__unknown", label: props.unknownLabel, color: UNKNOWN_FILL, n: unknownCount, k: unknownIdx }] : []),
  ];
  const rows = legendRows(chips);
  const legendBottom = LEGEND_TOP + rows * CHIP_H + (rows - 1) * LEGEND_GAP;
  const ctaTop = Math.max(1540, legendBottom + 40);
  // 出典行は 1 行固定。長い出典名 (「(latest available)」付き等) は省略符より先に字を縮める
  const sourceFont = [28, 26, 24, 22].find((f) => EM(props.sourceLine) * f + props.sourceLine.length <= 960) ?? 22;

  const titleIn = spring({ frame, fps, config: { damping: 14, stiffness: 160, mass: 0.6 }, durationInFrames: 10 });
  const underline = interpolate(frame, [4, 14], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const ctaIn = spring({ frame: frame - Math.round(CTA_AT_SEC * fps), fps, config: { damping: 12, stiffness: 170, mass: 0.6 }, durationInFrames: 12 });
  const zoom = interpolate(frame, [0, durationInFrames - 1], [1, ZOOM_END], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const now = currentLine(props.narration, frame / fps);
  const activeKeys = new Set(now?.line.keys ?? []);
  const lit = now?.line.highlight ? world.countries.filter((c) => c.id === now.line.highlight) : [];
  const caption = useMemo(() => {
    if (!now) return null;
    for (const fontSize of CAPTION_SIZES) {
      const lines = wrapText(now.line.text, CAPTION_FIT_W, fontSize, 2);
      if (lines) return { fontSize, lines };
    }
    return { fontSize: CAPTION_SIZES[CAPTION_SIZES.length - 1], lines: [now.line.text] };
  }, [now?.line.text]);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 50% 52%, ${T.bgLift} 0%, ${T.bg} 70%)`, fontFamily: FONT }}>
      {/* brand chip */}
      <div style={{ position: "absolute", left: 60, top: 76, display: "flex", alignItems: "center", gap: 12, opacity: 0.75 }}>
        <div style={{ width: 8, height: 24, background: T.accent }} />
        <div style={{ color: T.muted, fontSize: 22, fontWeight: 800, letterSpacing: 4 }}>
          {props.brand.toUpperCase()}
        </div>
      </div>

      {/* title */}
      <div
        style={{
          position: "absolute", left: 60, top: 180, width: 960,
          opacity: titleIn, transform: `scale(${0.92 + 0.08 * titleIn})`, transformOrigin: "left top",
          color: T.ink, fontWeight: 900, fontSize: title.fontSize, lineHeight: `${Math.round(title.fontSize * 1.04)}px`,
          letterSpacing: -2,
        }}
      >
        {title.lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ marginTop: 22, width: 160 * underline, height: 8, background: T.accent }} />
      </div>

      {/* map */}
      <svg
        width={W} height={1920} viewBox={`0 0 ${W} 1920`}
        style={{ position: "absolute", left: 0, top: 0, transform: `scale(${zoom})`, transformOrigin: `540px ${(world.bounds.y0 + world.bounds.y1) / 2}px` }}
      >
        <g>
          {world.countries.map((c, i) => <path key={i} d={c.d} fill={UNKNOWN_FILL} />)}
        </g>
        {props.legend.map((l, k) => {
          const t = categoryT(k);
          if (t <= 0) return null;
          return (
            <g key={l.key} opacity={t}>
              {world.countries.filter((c) => keyOf(c.id) === l.key).map((c, i) => <path key={i} d={c.d} fill={l.color} />)}
            </g>
          );
        })}
        <path d={world.borders} fill="none" stroke={BORDER} strokeWidth={1.2} strokeLinejoin="round" />
        {lit.map((c, i) => <path key={`lit${i}`} d={c.d} fill="none" stroke="#FFFFFF" strokeWidth={3} strokeLinejoin="round" />)}
      </svg>

      {props.narration && (
        <Sequence from={Math.round(props.narration.offsetSec * fps)} name="narration">
          <Audio src={staticFile(props.narration.audio)} />
        </Sequence>
      )}

      {/* caption: 読んでいる語だけ accent 色 */}
      {now && caption && (
        <div
          style={{
            position: "absolute", left: 60, top: CAPTION_TOP, width: 960, textAlign: "center",
            color: T.ink, fontSize: caption.fontSize, fontWeight: 800, lineHeight: `${Math.round(caption.fontSize * 1.18)}px`,
            textShadow: "0 2px 8px rgba(0,0,0,.6)",
          }}
        >
          {captionWords(caption.lines, now.line.words, now.t)}
        </div>
      )}

      {/* legend */}
      <div
        style={{
          position: "absolute", left: 60, top: LEGEND_TOP, width: LEGEND_W,
          display: "flex", flexWrap: "wrap", justifyContent: "center", gap: LEGEND_GAP,
        }}
      >
        {chips
          .map((chip) => {
            const t = categoryT(chip.k);
            const on = activeKeys.has(chip.key);
            return (
              <div
                key={chip.key}
                style={{
                  display: "flex", alignItems: "center", gap: 14, height: CHIP_H, padding: "0 22px 0 16px",
                  background: T.bgLift, border: `2px solid ${on ? T.accent : T.rule}`, borderRadius: 14,
                  opacity: t, transform: `translateY(${(1 - t) * 14}px) scale(${on ? 1.08 : 1})`,
                  boxShadow: on ? `0 0 24px ${T.accent}55` : "none",
                }}
              >
                <div style={{ width: 34, height: 34, borderRadius: 7, background: chip.color, boxShadow: "inset 0 0 0 2px rgba(255,255,255,.14)" }} />
                <div style={{ color: T.ink, fontSize: CHIP_FONT, fontWeight: 800, whiteSpace: "nowrap" }}>{chip.label}</div>
                <div style={{ color: T.muted, fontSize: COUNT_FONT, fontWeight: 600, whiteSpace: "nowrap" }}>{chip.n}</div>
              </div>
            );
          })}
      </div>

      {/* cta */}
      <div
        style={{
          position: "absolute", left: 60, top: ctaTop, width: 960, textAlign: "center",
          color: T.accent, fontSize: 54, fontWeight: 800, letterSpacing: -0.5,
          opacity: ctaIn, transform: `translateY(${(1 - ctaIn) * 18}px)`,
        }}
      >
        {props.cta}
      </div>

      {/* source */}
      <div
        style={{
          position: "absolute", left: 60, top: 1700, width: 960, textAlign: "center",
          color: T.ink, opacity: 0.55, fontSize: sourceFont, fontWeight: 600, letterSpacing: 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {props.sourceLine}
      </div>
    </AbsoluteFill>
  );
};

/** 字幕の行を語に分け、いま読んでいる語に accent 色を付ける。語の対応は先頭から順に取る。 */
function captionWords(lines: string[], words: Array<{ w: string; t: number; d: number }>, t: number) {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  let wi = 0;
  return lines.map((line, li) => (
    <div key={li} style={{ whiteSpace: "nowrap" }}>
      {line.split(/\s+/).map((tok, ti) => {
        let hit = false;
        if (wi < words.length && norm(words[wi].w) && norm(tok).startsWith(norm(words[wi].w).slice(0, 3))) {
          const w = words[wi++];
          hit = t >= w.t && t < w.t + w.d + 0.05;
        }
        return <span key={ti} style={{ color: hit ? T.accent : T.ink }}>{ti ? " " : ""}{tok}</span>;
      })}
    </div>
  ));
}
