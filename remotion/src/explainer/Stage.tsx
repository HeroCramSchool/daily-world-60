import React from "react";
import { AbsoluteFill, Img, staticFile, interpolate, Easing } from "remotion";
import { FONT } from "../lib/theme";
import { EM } from "../lib/fit";
import type { XMapLabel } from "../lib/explainerTypes";

export const W = 1080;
export const H = 1920;
export const NAVY = "#0F1B3D";
export const STRIKE = "#FF5A4E";
/** Shorts の右レールと下の題名帯に隠れない範囲。 */
export const SAFE = { left: 60, right: 900, top: 200, bottom: 1350 };
/** 図を置く帯。地図 PNG の陸ドットと同じ y 470〜1130。 */
export const BAND = { top: 470, bottom: 1130 };
export const CONTENT_W = SAFE.right - SAFE.left;
// fit.ts の字幅見積は Inter Black (特に大文字) より狭い。見積に使う幅を 1 割詰めて実際の折り返しを箱に収める
export const FIT_W = Math.round(CONTENT_W * 0.88);

export const clamp01 = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const easeOut = (frame: number, start: number, len: number) =>
  interpolate(frame, [start, start + len], [0, 1], { easing: Easing.out(Easing.cubic), ...clamp01 });

/** 地図以外の図の背景。地図 PNG と同じ紺地に経緯線ふうの格子を敷く。 */
export const Stage: React.FC = () => (
  <AbsoluteFill style={{ background: NAVY }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <g stroke="#2A3A5E" strokeWidth={2} opacity={0.35}>
        {Array.from({ length: 10 }, (_, i) => <line key={`v${i}`} x1={60 + i * 120} y1={0} x2={60 + i * 120} y2={H} />)}
        {Array.from({ length: 17 }, (_, i) => <line key={`h${i}`} x1={0} y1={110 + i * 120} x2={W} y2={110 + i * 120} />)}
      </g>
    </svg>
    <AbsoluteFill style={{ background: "radial-gradient(ellipse 70% 40% at 45% 42%, rgba(91,114,144,.20) 0%, rgba(15,27,61,0) 70%)" }} />
  </AbsoluteFill>
);

export type Push = { cx: number; cy: number; s: number };

/** 地図をゆっくり寄せる。中心は点の重心。0 フレーム目は等倍なので 1 フレーム目の絵が欠けない。 */
export function pushFor(points: Array<{ x: number; y: number }>, local: number, span: number, gain = 0.07): Push {
  const cx = points.length ? points.reduce((a, p) => a + p.x, 0) / points.length : W / 2;
  const cy = points.length ? points.reduce((a, p) => a + p.y, 0) / points.length : (BAND.top + BAND.bottom) / 2;
  const p = interpolate(local, [0, Math.max(1, span)], [0, 1], { easing: Easing.inOut(Easing.sin), ...clamp01 });
  return { cx, cy, s: 1 + gain * p };
}

export const pushed = (q: Push, x: number, y: number): [number, number] => [q.cx + (x - q.cx) * q.s, q.cy + (y - q.cy) * q.s];

export const MapBg: React.FC<{ bg: string; push: Push }> = ({ bg, push }) => (
  <AbsoluteFill style={{ background: NAVY }}>
    <Img
      src={staticFile(bg)}
      style={{
        position: "absolute", left: 0, top: 0, width: W, height: H,
        transform: `scale(${push.s})`, transformOrigin: `${push.cx}px ${push.cy}px`,
      }}
    />
  </AbsoluteFill>
);

const LABEL_FILL: Record<XMapLabel["tone"], string> = { focus: "#C9D6E8", country: "#7D8FA8", sea: "#5C7EA6" };

/**
 * 地図の国名・海の名。背景と一緒に寄る。点とそのラベル (avoid、寄せ切った後の座標) に重なる名前は出さない。
 * 判定は寄せ切った後 (fin) の位置で行い、途中で出たり消えたりしないようにする。
 */
export const MapLabels: React.FC<{ labels?: XMapLabel[]; push: Push; fin: Push; avoid: Rect[] }> = ({ labels, push, fin, avoid }) => (
  <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
    {(labels ?? []).filter(l => {
      const [fx, fy] = pushed(fin, l.x, l.y);
      const half = (l.text.length * l.size * 0.78 * fin.s) / 2;
      const box: Rect = { l: fx - half, r: fx + half, t: fy - l.size * fin.s, b: fy + l.size * 0.3 * fin.s };
      return !avoid.some(a => overlap(a, box));
    }).map((l, i) => {
      const [x, y] = pushed(push, l.x, l.y);
      return (
        <text key={i} x={x} y={y} textAnchor="middle" fontFamily={FONT} fontWeight={l.tone === "sea" ? 600 : 800}
          fontStyle={l.tone === "sea" ? "italic" : "normal"} fontSize={l.size * push.s} letterSpacing={l.size * 0.18} fill={LABEL_FILL[l.tone]}>
          {l.text}
        </text>
      );
    })}
  </svg>
);

/** 点とそのラベルが占める矩形 (寄せ切った後の画面座標)。地図の国名はここに重ねない。 */
export function pinLabelRects(points: Array<{ x: number; y: number }>, spots: LabelSpot[], fin: Push): Rect[] {
  return points.flatMap((p, i) => {
    const [x, y] = pushed(fin, p.x, p.y);
    const s = spots[i];
    const pin: Rect = { l: x - 40, r: x + 40, t: y - 40, b: y + 40 };
    return s ? [pin, { l: x + s.dx - 12, r: x + s.dx + s.w + 12, t: y + s.dy - s.size * 0.9, b: y + s.dy + s.size * 0.35 }] : [pin];
  });
}

/** 地図の点。見た目は short/MapScene.tsx のマーカーと同じ (リング・塗り・中の紺点)。 */
export const Pin: React.FC<{ x: number; y: number; t: number; color: string; pulse: number | null }> = ({ x, y, t, color, pulse }) => {
  if (t <= 0) return null;
  const ringR = pulse === null ? 34 : 26 + pulse * 34;
  const ringOp = (pulse === null ? 0.18 : 0.85 - pulse * 0.6) * Math.min(1, t);
  return (
    <g>
      <circle cx={x} cy={y} r={ringR} fill="none" stroke={color} strokeWidth={5} opacity={ringOp} />
      <circle cx={x} cy={y} r={13 * t} fill={color} />
      <circle cx={x} cy={y} r={5 * Math.min(1, t)} fill={NAVY} />
    </g>
  );
};

export type LabelSpot = { dx: number; dy: number; w: number; size: number; text: string; lead: boolean };

const LABEL_SIZE = 40;
const LABEL_GAP = 26;
const PIN_R = 22;

type Ends = { a: [number, number]; b: [number, number] };
export type Rect = { l: number; r: number; t: number; b: number };
const overlap = (p: Rect, q: Rect) => p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;

/**
 * 点のラベルを SAFE の左右 (60〜900) に収めて置く。点の右・左、下・上の順に試し、
 * 先に置いたラベルや他の点と重なるなら点から1段ずつ離す (離したときは引き出し線を付ける)。
 * a は寄せる前、b は寄せ切った後の画面座標。位置は点からのずれで返し、両端で収まるものを
 * 選ぶので寄せの途中で跳ばない。
 */
export function placeLabels(points: Array<Ends & { text: string }>, verticalFirst = false): LabelSpot[] {
  const rects = (e: Ends, s: LabelSpot): Rect[] =>
    [e.a, e.b].map(([x, y]) => ({ l: x + s.dx, r: x + s.dx + s.w, t: y + s.dy - s.size * 0.78, b: y + s.dy + s.size * 0.2 }));
  // 寄せる前と後で別々に判定する ([0] = a, [1] = b)
  const pin = ([x, y]: [number, number]): Rect => ({ l: x - PIN_R, r: x + PIN_R, t: y - PIN_R, b: y + PIN_R });
  const pins: Rect[][] = [points.map(e => pin(e.a)), points.map(e => pin(e.b))];
  const taken: Rect[][] = [[], []];
  const fits = (e: Ends, s: LabelSpot) => rects(e, s).every(r => r.l >= SAFE.left && r.r <= SAFE.right);
  const free = (e: Ends, s: LabelSpot) =>
    rects(e, s).every((r, k) => !taken[k].some(q => overlap(r, q)) && !pins[k].some(q => overlap(r, q)));

  const out: LabelSpot[] = [];
  for (const p of points) {
    const text = p.text.toUpperCase();
    const em = Math.max(0.01, EM(text));
    const size = Math.min(LABEL_SIZE, Math.floor((CONTENT_W * 0.9) / (em * 1.12)));
    const w = em * size * 1.12;
    const spot = (dx: number, dy: number, lead = false): LabelSpot => ({ dx, dy, w, size, text, lead });
    const side = [spot(LABEL_GAP, size * 0.36), spot(-LABEL_GAP - w, size * 0.36)];
    const cands: LabelSpot[] = verticalFirst ? [] : [...side];
    for (let k = 0; k < 5; k++) {
      for (const dy of [PIN_R + 14 + size * 0.78 + k * size * 1.2, -PIN_R - 14 - size * 0.2 - k * size * 1.2]) {
        for (const dx of [-w / 2, -w + 30, -30]) cands.push(spot(dx, dy, k > 0));
      }
      if (k === 0 && verticalFirst) cands.push(...side);
    }
    let pick = cands.find(c => fits(p, c) && free(p, c));
    if (!pick) {
      const lo = SAFE.left - Math.min(p.a[0], p.b[0]);
      const hi = SAFE.right - w - Math.max(p.a[0], p.b[0]);
      pick = spot(Math.min(hi, Math.max(lo, -w / 2)), PIN_R + 14 + size * 0.78, true);
    }
    rects(p, pick).forEach((r, k) => taken[k].push(r));
    out.push(pick);
  }
  return out;
}

export const Label: React.FC<{ x: number; y: number; spot: LabelSpot; opacity: number }> = ({ x, y, spot, opacity }) => {
  const below = spot.dy > 0;
  const lx = Math.min(x + spot.dx + spot.w, Math.max(x + spot.dx, x));
  const ly = below ? y + spot.dy - spot.size * 0.82 : y + spot.dy + spot.size * 0.24;
  return (
    <g opacity={opacity}>
      {spot.lead && <line x1={x} y1={y + (below ? PIN_R : -PIN_R)} x2={lx} y2={ly} stroke="rgba(255,255,255,.7)" strokeWidth={3} strokeLinecap="round" />}
      <text
        x={x + spot.dx} y={y + spot.dy}
        fontFamily={FONT} fontWeight={900} fontSize={spot.size}
        fill="#FFFFFF" stroke={NAVY} strokeWidth={7} paintOrder="stroke"
      >
        {spot.text}
      </text>
    </g>
  );
};
