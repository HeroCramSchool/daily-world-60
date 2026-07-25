/**
 * 紛争地図シーン (フランチャイズ映像): 地域にフレーミングしたドット地図に
 * マーカー(攻撃地点/都市)が脈動しながら順に現れるアニメーションフレームを生成する。
 * 実測で勝っている「動く地図」形式 (History on Maps 411K/194本, Dominik toxic 1.08億再生/204本)
 * の自動化版。フレームは SVG 文字列で返し、呼び出し側 (build-news-video) が PNG 化して
 * 既存の svgs+wordDurs 機構 (concat demuxer + 連続ズーム) でアニメ化する。
 * 依存: worldmap.ts の LAND 近似のみ (オフライン・無料)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { countryLonLat, worldDotsInRegion } from "./worldmap.js";

// ── 実海岸線 (Natural Earth 50m, パブリックドメイン, assets/ne-land.json に軽量化同梱) ──
// 地域ズームでは worldmap.ts の大陸楕円近似が破綻する (黒海沿岸が存在しない等) ため、
// ドットの陸判定はレイキャスト point-in-polygon で行う。asset 欠落時は楕円にフォールバック。
type Poly = { pts: Array<[number, number]>; bbox: [number, number, number, number] };
let landPolys: Poly[] | null | undefined;

function loadLand(): Poly[] | null {
  if (landPolys !== undefined) return landPolys;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, "..", "..", "assets", "ne-land.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { polys: Array<Array<[number, number]>> };
    landPolys = raw.polys.map(pts => {
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
      for (const [lon, lat] of pts) {
        if (lon < x0) x0 = lon; if (lon > x1) x1 = lon;
        if (lat < y0) y0 = lat; if (lat > y1) y1 = lat;
      }
      return { pts, bbox: [x0, y0, x1, y1] };
    });
  } catch {
    landPolys = null;
  }
  return landPolys;
}

function isLandGeo(lon: number, lat: number, polys: Poly[]): boolean {
  for (const poly of polys) {
    const [x0, y0, x1, y1] = poly.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    let inside = false;
    const pts = poly.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

export type MapMarker = {
  lon: number;
  lat: number;
  label?: string;
  kind?: "strike" | "city" | "event";
};

export type MapLane = {
  focus: [number, number];
  markers: MapMarker[];
  dayBadge?: string;   // 例 "DAY 1247"
  counter?: string;    // 例 "13 SHIPS HIT"
};

const W = 1080;
const H = 1920;
// 地図のアクション帯: 見出し(~Y460)と字幕ボックス(Y1150~)の間。
const BAND_TOP = 470;
const BAND_BOTTOM = 1130;

type Viewport = { lonMin: number; lonMax: number; latMin: number; latMax: number };

/** 地域内の陸ドット (実海岸線)。ピッチはスパン比例 = どの倍率でも密度一定。 */
function regionDots(vp: Viewport, p: (lon: number, lat: number) => [number, number]): string {
  const polys = loadLand();
  if (!polys) {
    return worldDotsInRegion(vp.lonMin, vp.lonMax, vp.latMin, vp.latMax, p);
  }
  const step = Math.max(0.15, (vp.lonMax - vp.lonMin) / 46);
  const r = Math.max(4, Math.min(10, 430 * step / (vp.lonMax - vp.lonMin)));
  let s = `<g fill="#5B7290" opacity="0.9">`;
  for (let lat = vp.latMax; lat >= vp.latMin; lat -= step) {
    for (let lon = vp.lonMin; lon <= vp.lonMax; lon += step) {
      if (!isLandGeo(lon, lat, polys)) continue;
      const [x, y] = p(lon, lat);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
    }
  }
  return s + `</g>`;
}

/** マーカー群+focus を含む最小ビューポートを計算し、余白と画面比を integrate する。 */
export function regionViewport(lane: MapLane): Viewport {
  const lons = [lane.focus[0], ...lane.markers.map(m => m.lon)];
  const lats = [lane.focus[1], ...lane.markers.map(m => m.lat)];
  let lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  let latMin = Math.min(...lats), latMax = Math.max(...lats);
  // 最低スパン (単一マーカーでも国が見える) + 20% パディング
  const minSpanLon = 14, minSpanLat = 10;
  const padLon = Math.max(minSpanLon - (lonMax - lonMin), (lonMax - lonMin) * 0.4) / 2;
  const padLat = Math.max(minSpanLat - (latMax - latMin), (latMax - latMin) * 0.4) / 2;
  lonMin -= padLon; lonMax += padLon; latMin -= padLat; latMax += padLat;
  // アスペクト調整: アクション帯 (1080 x 660) に等方で収める。
  // 経度1度の実距離は cos(lat) で縮むが、ドット地図の様式表現なので等角近似で十分。
  const bandW = W - 120, bandH = BAND_BOTTOM - BAND_TOP;
  const spanLon = lonMax - lonMin, spanLat = latMax - latMin;
  const scaleX = bandW / spanLon, scaleY = bandH / spanLat;
  if (scaleX < scaleY) {
    const need = bandH / scaleX;
    const extra = (need - spanLat) / 2;
    latMin -= extra; latMax += extra;
  } else {
    const need = bandW / scaleY;
    const extra = (need - spanLon) / 2;
    lonMin -= extra; lonMax += extra;
  }
  return { lonMin, lonMax, latMin, latMax };
}

function project(vp: Viewport): (lon: number, lat: number) => [number, number] {
  const bandW = W - 120, bandH = BAND_BOTTOM - BAND_TOP;
  return (lon, lat) => [
    60 + ((lon - vp.lonMin) / (vp.lonMax - vp.lonMin)) * bandW,
    BAND_TOP + ((vp.latMax - lat) / (vp.latMax - vp.latMin)) * bandH,
  ];
}

/**
 * 1フレーム分の地図 SVG (1080x1920 全面・紺背景)。
 * reveal   : 表示するマーカー数 (進行表示。cue が進むほど増える)
 * pulse01  : 0..1 の脈動位相 (最後に現れたマーカーのリング半径/不透明度)
 */
export function mapFrameSvg(lane: MapLane, reveal: number, pulse01: number, accent = "#F5E63B"): string {
  const vp = regionViewport(lane);
  const p = project(vp);
  const dots = regionDots(vp, p);

  let markersSvg = "";
  const shown = lane.markers.slice(0, Math.max(1, reveal));
  // ラベル衝突回避: 配置済みラベル矩形と重なるなら下へ 46px ずつ退避。右端は実測幅でクランプ。
  const placed: Array<{ x: number; y: number; w: number }> = [];
  shown.forEach((m, i) => {
    const [x, y] = p(m.lon, m.lat);
    const isLatest = i === shown.length - 1;
    const strike = (m.kind ?? "strike") === "strike";
    const color = strike ? "#FF5A4E" : accent;
    // 脈動リング: 最新マーカーのみ拡大アニメ、既出は静的な薄いリング
    const ringR = isLatest ? 26 + pulse01 * 34 : 34;
    const ringOp = isLatest ? 0.85 - pulse01 * 0.6 : 0.18;
    markersSvg += `
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${ringR.toFixed(1)}" fill="none" stroke="${color}" stroke-width="5" opacity="${ringOp.toFixed(2)}"/>
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="${color}"/>
  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#0F1B3D"/>`;
    if (m.label) {
      const text = m.label.toUpperCase();
      const estW = text.length * 24 + 10;
      const lx = Math.min(W - 60 - estW, Math.max(70, x + 26));
      // 既定で上下交互に配置 (密集地域での初期衝突を減らす)。衝突時はさらに下へ退避。
      let ly = y < BAND_TOP + 80 ? y + 64 : (i % 2 === 1 ? y + 58 : y - 30);
      for (let guard = 0; guard < 6; guard++) {
        const hit = placed.some(q => Math.abs(q.y - ly) < 44 && lx < q.x + q.w && q.x < lx + estW);
        if (!hit) break;
        ly += 46;
      }
      placed.push({ x: lx, y: ly, w: estW });
      markersSvg += `
  <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="Hiragino Sans" font-weight="900" font-size="34"
        fill="#FFFFFF" stroke="#0F1B3D" stroke-width="6" paint-order="stroke">${escapeXml(text)}</text>`;
    }
  });

  const dayBadge = lane.dayBadge
    ? `<rect x="60" y="${BAND_TOP + 10}" width="${34 * lane.dayBadge.length + 44}" height="66" fill="#FF5A4E" rx="10"/>
  <text x="${60 + (34 * lane.dayBadge.length + 44) / 2}" y="${BAND_TOP + 58}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900" font-size="40" fill="#FFFFFF" letter-spacing="2">${escapeXml(lane.dayBadge)}</text>`
    : "";
  // カウンターは右上 (DAY バッジの対角) = 中央のアクション帯とマーカーラベルに重ねない。
  const counter = lane.counter
    ? `<text x="${W - 70}" y="${BAND_TOP + 64}" text-anchor="end" font-family="Hiragino Sans" font-weight="900" font-size="64" fill="${accent}" stroke="#0F1B3D" stroke-width="8" paint-order="stroke">${escapeXml(lane.counter)}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>
  <g opacity="0.35">${gridLines(vp, p)}</g>
  ${dots}
  ${markersSvg}
  ${dayBadge}
  ${counter}
</svg>`;
}

/** 経緯線 (5度間隔) の薄いグリッド。地図らしさ + 動きの基準線。 */
function gridLines(vp: Viewport, p: (lon: number, lat: number) => [number, number]): string {
  let s = `<g stroke="#2A3A5E" stroke-width="2">`;
  const lonStep = niceStep(vp.lonMax - vp.lonMin);
  const latStep = niceStep(vp.latMax - vp.latMin);
  for (let lon = Math.ceil(vp.lonMin / lonStep) * lonStep; lon <= vp.lonMax; lon += lonStep) {
    const [x1, y1] = p(lon, vp.latMax); const [x2, y2] = p(lon, vp.latMin);
    s += `<line x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}"/>`;
  }
  for (let lat = Math.ceil(vp.latMin / latStep) * latStep; lat <= vp.latMax; lat += latStep) {
    const [x1, y1] = p(vp.lonMin, lat); const [x2, y2] = p(vp.lonMax, lat);
    s += `<line x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}"/>`;
  }
  return s + `</g>`;
}

function niceStep(span: number): number {
  if (span > 60) return 20;
  if (span > 30) return 10;
  if (span > 12) return 5;
  return 2;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Routine 出力 (story.mapFocus / story.mapMarkers / headline) から MapLane を組み立てる。
 *  focus 無し→マーカー重心→国コード中心の順でフォールバック。マーカー0件は null (地図レーン不成立)。 */
export function laneFromStory(story: {
  headline?: string;
  country?: { code?: string };
  mapFocus?: { lon?: number; lat?: number };
  mapMarkers?: Array<{ lon?: number; lat?: number; label?: string; kind?: string }>;
  mapDay?: string | number;
  mapCounter?: string;
}): MapLane | null {
  const markers: MapMarker[] = (story.mapMarkers ?? [])
    .filter(m => typeof m.lon === "number" && typeof m.lat === "number"
      && Math.abs(m.lon!) <= 180 && Math.abs(m.lat!) <= 90)
    .slice(0, 6)
    .map(m => ({
      lon: m.lon!, lat: m.lat!,
      ...(m.label ? { label: String(m.label).slice(0, 18) } : {}),
      kind: (m.kind === "city" || m.kind === "event" ? m.kind : "strike") as MapMarker["kind"],
    }));
  if (!markers.length) return null;
  let focus: [number, number] | null = null;
  if (typeof story.mapFocus?.lon === "number" && typeof story.mapFocus?.lat === "number") {
    focus = [story.mapFocus.lon, story.mapFocus.lat];
  } else {
    focus = [
      markers.reduce((a, m) => a + m.lon, 0) / markers.length,
      markers.reduce((a, m) => a + m.lat, 0) / markers.length,
    ];
  }
  const cc = story.country?.code ? countryLonLat(story.country.code) : null;
  if (!focus && cc) focus = cc;
  if (!focus) return null;
  const day = story.mapDay !== undefined && story.mapDay !== null && String(story.mapDay).trim() !== ""
    ? `DAY ${String(story.mapDay).replace(/^day\s*/i, "")}` : undefined;
  return {
    focus, markers,
    ...(day ? { dayBadge: day } : {}),
    ...(story.mapCounter ? { counter: String(story.mapCounter).toUpperCase().slice(0, 22) } : {}),
  };
}
