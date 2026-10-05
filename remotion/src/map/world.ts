import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { Topology, GeometryCollection, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import topology from "../../public/maps/countries-110m.json";

/**
 * world-atlas countries-110m (Natural Earth, CC0) を 1 回だけ投影して path 文字列にする。
 * 南極 (id "010") は除外。geoNaturalEarth1 を幅 MAP_W に合わせ、縦は MAP_CY を中心に置く。
 * id が無い 3 件 (N. Cyprus / Somaliland / Kosovo) は常に unknown 色で描かれる。
 */
export const MAP_W = 1056;
export const MAP_CY = 930;
const ANTARCTICA = "010";

interface CountryProps { name?: string }
const idOf = (g: GeometryObject) => String((g as { id?: string | number }).id);

export interface CountryPath {
  id: string | null;
  name: string;
  d: string;
}

export interface WorldPaths {
  countries: CountryPath[];
  borders: string;
  /** 投影後の地図全体の外接矩形 (キャンバス座標) */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

function build(): WorldPaths {
  const topo = topology as unknown as Topology<{ countries: GeometryCollection<CountryProps> }>;
  const all = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, CountryProps>;
  const keep = all.features.filter((f) => String(f.id) !== ANTARCTICA);
  const fc: FeatureCollection<Geometry, CountryProps> = { type: "FeatureCollection", features: keep };

  const projection = geoNaturalEarth1().fitWidth(MAP_W, fc);
  const path = geoPath(projection);
  const [[bx0, by0], [bx1, by1]] = path.bounds(fc);
  const dx = (1080 - MAP_W) / 2 - bx0;
  const dy = MAP_CY - (by0 + by1) / 2;
  const [tx, ty] = projection.translate();
  projection.translate([tx + dx, ty + dy]);

  const countries: CountryPath[] = keep.map((f: Feature<Geometry, CountryProps>) => ({
    id: f.id === undefined || f.id === null ? null : String(f.id),
    name: f.properties?.name ?? "",
    d: path(f) ?? "",
  }));

  const borders = path(
    mesh(topo, topo.objects.countries, (a, b) => idOf(a) !== ANTARCTICA && idOf(b) !== ANTARCTICA)
  ) ?? "";

  return {
    countries,
    borders,
    bounds: { x0: bx0 + dx, y0: by0 + dy, x1: bx1 + dx, y1: by1 + dy },
  };
}

let cache: WorldPaths | null = null;
export function worldPaths(): WorldPaths {
  if (!cache) cache = build();
  return cache;
}
