import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { geoContains } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import { realMapScene } from "./realmap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const topo = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "assets", "realmap", "countries.json"), "utf-8")) as Topology;
const countries = (feature(topo, topo.objects.countries as GeometryCollection) as FeatureCollection<Geometry, { NAME_EN?: string }>).features;
const countryAt = (lon: number, lat: number) => countries.filter((f: Feature) => geoContains(f, [lon, lat])).map(f => f.properties.NAME_EN);

test("国境は米国視点 (オーナー 2026-11-01): クリミアとドネツクはウクライナ、コソボは独立国", () => {
  assert.deepEqual(countryAt(34.10, 44.95), ["Ukraine"]);
  assert.deepEqual(countryAt(37.80, 48.00), ["Ukraine"]);
  assert.deepEqual(countryAt(21.17, 42.66), ["Kosovo"]);
  assert.deepEqual(countryAt(36.19, 51.73), ["Russia"]);
});

test("点は右のボタン列と見出し・字幕を避けた範囲に入り、名前は画面からはみ出さない", () => {
  const m = realMapScene([
    { label: "Kursk", lon: 36.19, lat: 51.73 },
    { label: "Oryol", lon: 36.06, lat: 52.97 },
    { label: "Crimea", lon: 34.10, lat: 45.30 },
  ], "UA");
  for (const p of m.points) {
    assert.ok(p.x >= 60 && p.x <= 900, `${p.label} x=${p.x}`);
    assert.ok(p.y >= 430 && p.y <= 1290, `${p.label} y=${p.y}`);
  }
  assert.deepEqual(m.points.map(p => p.label), ["KURSK", "ORYOL", "CRIMEA"]);
  assert.ok(m.labels.some(l => l.text === "UKRAINE" && l.tone === "focus"));
  for (const l of m.labels) {
    const half = (l.text.length * l.size * 0.78) / 2;
    assert.ok(l.x - half >= 24 && l.x + half <= 930, `${l.text} x=${l.x}`);
  }
  assert.match(m.svg, /^<svg /);
});

test("点が1つでも、狭い範囲 (ガザ) でも描ける", () => {
  assert.equal(realMapScene([{ label: "Taipei", lon: 121.56, lat: 25.03 }], "TW").points.length, 1);
  const gaza = realMapScene([{ label: "Gaza City", lon: 34.45, lat: 31.5 }, { label: "Rafah", lon: 34.25, lat: 31.29 }], "PS");
  const [a, b] = gaza.points;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 40, "近い2点も離して見える");
  assert.throws(() => realMapScene([], "UA"));
});
