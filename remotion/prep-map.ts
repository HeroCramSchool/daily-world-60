import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Map Short の props を作る (docs/map-short.md)。
 *
 * 入力:  content/maps/registry.json (地図定義・data は cca3 キー)
 *        content/maps/countries.json (REST Countries スナップショット・cca3→ccn3 の変換に使う)
 * 出力:  remotion/props-map.json
 *
 *   npx tsx remotion/prep-map.ts <mapId>
 *   MAPS_DIR=/path/to/dir で入力ディレクトリを差し替えられる (テスト用)。
 */

const FPS = 30;
const DEFAULT_DURATION_SEC = 7;
const BRAND = "Daily World 60";

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const MAPS_DIR = process.env.MAPS_DIR ? path.resolve(process.env.MAPS_DIR) : path.join(ROOT, "content", "maps");

interface Legend { key: string; label: string; color: string }
interface MapDef {
  id: string;
  title: string;
  shortTitle: string;
  cta: string;
  legend: Legend[];
  data: Record<string, string>;
  unknownLabel?: string;
  source: { name: string; url: string; year: number | string; fetchedAt?: string };
  descriptionNote?: string;
  durationSec?: number;
}
interface Registry { maps: MapDef[] }

interface Country { cca2?: string; cca3: string; ccn3?: string; name?: string | { common?: string } }

function countryList(raw: unknown): Country[] {
  if (Array.isArray(raw)) return raw as Country[];
  if (raw && typeof raw === "object") {
    for (const k of ["countries", "items", "data"]) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Country[];
    }
  }
  throw new Error("countries.json: 配列か {countries|items|data: [...]} の形が必要");
}

async function main() {
  const mapId = process.argv[2];
  const registry = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "registry.json"), "utf-8")) as Registry;
  const maps = registry.maps ?? [];
  if (!mapId) {
    console.error(`usage: tsx prep-map.ts <mapId>\n  ids: ${maps.map(m => m.id).join(", ")}`);
    process.exit(1);
  }
  const map = maps.find(m => m.id === mapId);
  if (!map) {
    console.error(`[prep-map] "${mapId}" は registry.json に無い。ids: ${maps.map(m => m.id).join(", ")}`);
    process.exit(1);
  }

  const countries = countryList(JSON.parse(await fs.readFile(path.join(MAPS_DIR, "countries.json"), "utf-8")));
  const ccn3ByCca3 = new Map<string, string>();
  for (const c of countries) {
    if (c.cca3 && c.ccn3) ccn3ByCca3.set(c.cca3.toUpperCase(), String(c.ccn3).padStart(3, "0"));
  }

  const legendKeys = new Set(map.legend.map(l => l.key));
  const byNumeric: Record<string, string> = {};
  const unmapped: string[] = [];
  const badKeys: string[] = [];
  for (const [cca3, key] of Object.entries(map.data)) {
    const ccn3 = ccn3ByCca3.get(cca3.toUpperCase());
    if (!ccn3) { unmapped.push(cca3); continue; }
    if (!legendKeys.has(key)) badKeys.push(`${cca3}=${key}`);
    byNumeric[ccn3] = key;
  }
  // 本番コンテンツなので取りこぼしは落とす (warn にすると件数のずれた地図が投稿される)
  if (unmapped.length) throw new Error(`[prep-map] ${map.id}: unmapped cca3 (no ccn3 in countries.json): ${unmapped.length} → ${unmapped.join(", ")}`);
  if (badKeys.length) throw new Error(`[prep-map] ${map.id}: keys not in legend: ${badKeys.join(", ")}`);

  // 「最新年」混在のデータは出典行にそれを示す (internet-users: 2015〜2024 の最新値)
  const latest = /latest/i.test(map.descriptionNote ?? "") ? " (latest available)" : "";
  const props = {
    fps: FPS,
    durationSec: map.durationSec ?? DEFAULT_DURATION_SEC,
    title: map.title,
    shortTitle: map.shortTitle,
    cta: map.cta,
    legend: map.legend,
    byNumeric,
    unknownLabel: map.unknownLabel ?? "No data",
    sourceLine: `Source: ${map.source.name}, ${map.source.year}${latest}`,
    brand: BRAND,
    ...(map.descriptionNote ? { descriptionNote: map.descriptionNote } : {}),
  };
  await fs.writeFile(path.join(HERE, "props-map.json"), JSON.stringify(props, null, 2));

  // Root.tsx は props.json / props-short.json も静的 import する。地図だけ回す場合に備えて雛形を置く。
  const lf = path.join(HERE, "props.json");
  if (!(await exists(lf))) {
    await fs.writeFile(lf, JSON.stringify({ date: "", title: "", topic: "", fps: FPS, segments: [] }, null, 2));
  }
  const sf = path.join(HERE, "props-short.json");
  if (!(await exists(sf))) {
    await fs.writeFile(sf, JSON.stringify({ date: "", fps: FPS, videos: [] }, null, 2));
  }

  const perKey: Record<string, number> = {};
  for (const k of Object.values(byNumeric)) perKey[k] = (perKey[k] ?? 0) + 1;
  console.log(`[prep-map] ${map.id}: mapped ${Object.keys(byNumeric).length} / ${Object.keys(map.data).length} cca3 → props-map.json`);
  console.log(`[prep-map] per key: ${Object.entries(perKey).map(([k, n]) => `${k}=${n}`).join(", ")}`);
}

function exists(p: string) { return fs.access(p).then(() => true).catch(() => false); }

main().catch(e => { console.error(e); process.exit(1); });
