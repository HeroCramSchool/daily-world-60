/**
 * 解説形式の地図: 実際の国境・海岸線・川・湖を描いた背景 SVG と、点・国名・海の名の画面座標を返す。
 * 地図データは Natural Earth v5.1.2（パブリックドメイン）の米国視点の国境版を軽くしたもの（assets/realmap/）。
 * 標準版はクリミアをロシア領に描くので使わない。視点はオーナーが 2026-11-01 に米国を選んだ。
 * 文字は Remotion 側で描く（rsvg-convert の字体は Mac と Actions で違うため）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { geoContains, geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";

export type MapPlace = { lon: number; lat: number; label: string };
export type MapLabel = { x: number; y: number; text: string; size: number; tone: "focus" | "country" | "sea" };
export type RealMap = { svg: string; points: Array<{ x: number; y: number; label: string }>; labels: MapLabel[] };

const W = 1080;
const H = 1920;
// 見出し (〜y 420) と字幕 (y 1290〜) の間。上下の端は背景の紺へぼかす
const TOP = 430;
const BOT = 1290;
// 点は右レール (x 900〜) にかからない範囲に収める
const FIT: [[number, number], [number, number]] = [[110, TOP + 100], [850, BOT - 100]];
// 点どうしの広がりの3倍を最低限の範囲にする（ガザなら4度・キーウ〜ドニプロなら12度）
// 名前は Shorts の右のボタン列 (x 930〜) に掛けない
const RIGHT = 930;
const MIN_SPAN_LON: [number, number] = [4, 12];
const LAT_PER_LON = 0.66;
const BG = "#0F1B3D";

type Props = { ADM0_A3?: string; ISO_A2_EH?: string; NAME_EN?: string; name?: string; scalerank?: number };
type Layers = { countries: Feature<Geometry, Props>[]; rivers: Feature<Geometry, Props>[]; lakes: Feature<Geometry, Props>[]; seas: Feature<Point, Props>[] };

let cache: Layers | undefined;

function loadLayers(): Layers {
  if (cache) return cache;
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "realmap");
  const topo = (name: string) => {
    const t = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf-8")) as Topology;
    const obj = t.objects[name] as GeometryCollection<Props>;
    return (feature(t, obj) as FeatureCollection<Geometry, Props>).features;
  };
  const seas = JSON.parse(fs.readFileSync(path.join(dir, "seas.json"), "utf-8")) as FeatureCollection<Point, Props>;
  cache = { countries: topo("countries"), rivers: topo("rivers"), lakes: topo("lakes"), seas: seas.features };
  return cache;
}

/** 大文字・字間 0.18em の見積もり。はみ出しと重なりの判定に使う */
const textW = (t: string, size: number) => t.length * size * 0.78;

type Box = { x0: number; y0: number; x1: number; y1: number };
const OFFSETS: Array<[number, number]> = [[0, 0], [0, -110], [0, 110], [-170, 0], [170, 0], [-150, -110], [150, -110], [-150, 110], [150, 110], [0, -220], [0, 220]];
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function realMapScene(places: MapPlace[], focusIso2?: string): RealMap {
  if (!places.length) throw new Error("realMapScene: no places");
  const { countries, rivers, lakes, seas } = loadLayers();
  const lons = places.map(p => p.lon), lats = places.map(p => p.lat);
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  const spread = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
  const minLon = Math.min(MIN_SPAN_LON[1], Math.max(MIN_SPAN_LON[0], spread * 3));
  const sx = Math.max((Math.max(...lons) - Math.min(...lons)) * 1.5, minLon);
  const sy = Math.max((Math.max(...lats) - Math.min(...lats)) * 1.5, minLon * LAT_PER_LON);
  const proj = geoMercator().fitExtent(FIT, { type: "MultiPoint", coordinates: [[cx - sx / 2, cy - sy / 2], [cx + sx / 2, cy + sy / 2]] });
  proj.clipExtent([[0, TOP], [W, BOT]]);
  const geo = geoPath(proj);
  const focus = focusIso2?.toUpperCase();

  const points = places.map(p => {
    const [x, y] = proj([p.lon, p.lat]) ?? [W / 2, (TOP + BOT) / 2];
    return { x, y, label: p.label.toUpperCase() };
  });

  const land: string[] = [];
  const home: string[] = [];
  const named: Array<{ text: string; x: number; y: number; area: number; tone: MapLabel["tone"]; f?: Feature<Geometry, Props> }> = [];
  for (const f of countries) {
    const d = geo(f);
    if (!d) continue;
    const isFocus = !!focus && f.properties.ISO_A2_EH === focus;
    (isFocus ? home : land).push(`<path d="${d}"/>`);
    const area = geo.area(f);
    const [x, y] = geo.centroid(f);
    const text = (f.properties.NAME_EN ?? "").toUpperCase();
    if (text && area >= 14_000 && Number.isFinite(x) && Number.isFinite(y)) named.push({ text, x, y, area, tone: isFocus ? "focus" : "country", f });
  }
  for (const s of seas) {
    const xy = proj(s.geometry.coordinates as [number, number]);
    const text = (s.properties.name ?? "").toUpperCase();
    // 海の名は陸に掛けない（内側の点が陸の多角形に入る海は捨てる）
    if (!xy || !text || xy[1] <= TOP || xy[1] >= BOT) continue;
    if (countries.some(c => geoContains(c, s.geometry.coordinates as [number, number]))) continue;
    named.push({ text, x: xy[0], y: xy[1], area: 0, tone: "sea" });
  }

  // 話題の国・大きい国・海の順に置く。重心が点や他の名前とぶつかれば、同じ国の中で近くの位置を試す
  const taken: Box[] = points.map(p => ({ x0: p.x - 30, y0: p.y - 40, x1: p.x + 30 + textW(p.label, 34), y1: p.y + 40 }));
  const labels: MapLabel[] = [];
  const rank = (t: MapLabel["tone"]) => (t === "focus" ? 0 : t === "country" ? 1 : 2);
  for (const n of named.sort((a, b) => rank(a.tone) - rank(b.tone) || b.area - a.area)) {
    const size = n.tone === "sea" ? 24 : n.area > 150_000 ? 34 : n.area > 50_000 ? 28 : 22;
    const w = textW(n.text, size);
    for (const [dx, dy] of OFFSETS) {
      const x = n.x + dx, y = n.y + dy;
      const box = { x0: x - w / 2, y0: y - size, x1: x + w / 2, y1: y + size * 0.3 };
      if (box.x0 < 24 || box.x1 > RIGHT || box.y0 < TOP + 70 || box.y1 > BOT - 70) continue;
      if (taken.some(t => overlaps(t, box))) continue;
      const ll = proj.invert?.([x, y]);
      if (n.f && (dx || dy) && (!ll || !geoContains(n.f, ll))) continue;
      taken.push(box);
      labels.push({ x: Math.round(x), y: Math.round(y), text: n.text, size, tone: n.tone });
      break;
    }
  }

  const riv = rivers.map(r => geo(r)).filter(Boolean).map(d => `<path d="${d}"/>`).join("");
  const lak = lakes.map(l => geo(l)).filter(Boolean).map(d => `<path d="${d}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="fade" x1="0" y1="${TOP}" x2="0" y2="${BOT}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${BG}" stop-opacity="1"/><stop offset="0.09" stop-color="${BG}" stop-opacity="0"/>
    <stop offset="0.91" stop-color="${BG}" stop-opacity="0"/><stop offset="1" stop-color="${BG}" stop-opacity="1"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="${BG}"/>
<rect x="0" y="${TOP}" width="${W}" height="${BOT - TOP}" fill="#0E2238"/>
<g fill="#1D2A3B" stroke="#4A5D78" stroke-width="1.6" stroke-linejoin="round">${land.join("")}</g>
<g fill="#2A3F5E" stroke="#8FA6C6" stroke-width="2.6" stroke-linejoin="round">${home.join("")}</g>
<g fill="#0E2238">${lak}</g>
<g fill="none" stroke="#2C4C74" stroke-width="2.2" stroke-linecap="round">${riv}</g>
<rect x="0" y="${TOP}" width="${W}" height="${BOT - TOP}" fill="url(#fade)"/>
</svg>`;
  return { svg, points, labels };
}
