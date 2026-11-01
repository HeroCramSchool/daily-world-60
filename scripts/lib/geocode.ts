import * as fs from "node:fs/promises";
import { countryLonLat } from "./worldmap.js";

/**
 * 地名 → 経緯度。解説形式の地図 (remotion/prep-short.ts) が使う。
 * 1) その本の Routine の mapMarkers に同じ名前があればその座標 2) Wikipedia の記事の座標 3) null。
 * Wikipedia は国名が分かれば先に「地名, 国名」の記事を引き、無ければ地名だけで引く（PK の Hyderabad がインドの主記事になる類を避ける）。
 * どちらの答えも国の中心から遠すぎれば捨てる（同名の別の土地を拾わない）。
 * ネットの失敗では例外を出さない（呼び出し側は国の中心の地図に落とす）。
 */

export type GeoPoint = { lon: number; lat: number; source: "marker" | "wikipedia" };
export type GeoMarker = { lon?: number; lat?: number; label?: string };
export type GeocodeOptions = {
  markers?: GeoMarker[];
  /** その本の国の英語名（例: Pakistan）。 */
  countryName?: string;
  /** 結果を残す JSON。出力ディレクトリに置く（同じ日の描き直しで聞き直さない）。 */
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "DailyWorld60/1.0 (https://github.com/HeroCramSchool/daily-world-60)";
export const MAX_KM = 2500;
// worldmap.ts の国の中心は国土の真ん中なので、広い国は端の都市が 2500 km を超える（RU の中心はシベリアで、モスクワまで約 3,100 km）
const WIDE_KM: Record<string, number> = { RU: 4500, CA: 4500, US: 3000, CN: 3000, AU: 3000, ID: 3500 };

type LonLat = { lon: number; lat: number };
type Cache = Record<string, LonLat | null>;
const caches = new Map<string, Cache>();

export async function geocode(name: string, countryCode: string, opts: GeocodeOptions = {}): Promise<GeoPoint | null> {
  const q = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!q) return null;
  const want = q.toLowerCase();
  const m = (opts.markers ?? []).find(x => typeof x?.label === "string" && x.label.replace(/\s+/g, " ").trim().toLowerCase() === want && validLonLat(x.lon, x.lat));
  if (m) return { lon: m.lon!, lat: m.lat!, source: "marker" };

  const cc = String(countryCode ?? "").trim().toUpperCase();
  const key = `${cc}|${want}`;
  const cache = opts.cacheFile ? await loadCache(opts.cacheFile) : undefined;
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) {
    const c = cache[key];
    return c ? { ...c, source: "wikipedia" } : null;
  }

  const near = (title: string, p: LonLat | null): LonLat | null => {
    if (!p) return null;
    const km = distanceFromCountry(p, cc);
    const limit = WIDE_KM[cc] ?? MAX_KM;
    if (km !== null && km > limit) {
      console.warn(`[geocode] ${title}: ${Math.round(km)} km from ${cc} (limit ${limit} km) — ignored`);
      return null;
    }
    return p;
  };
  // どちらかを聞けなかったときは残さない（次の描き直しで聞き直す）
  let ok: LonLat | null = null;
  const country = String(opts.countryName ?? "").replace(/\s+/g, " ").trim();
  if (country && want !== country.toLowerCase() && !want.endsWith(`, ${country.toLowerCase()}`)) {
    const title = `${q}, ${country}`;
    const found = await askWikipedia(title, opts);
    if (found === undefined) return null;
    ok = near(title, found);
  }
  if (!ok) {
    const found = await askWikipedia(q, opts);
    if (found === undefined) return null;
    ok = near(q, found);
  }
  if (cache && opts.cacheFile) {
    cache[key] = ok;
    await fs.writeFile(opts.cacheFile, JSON.stringify(cache, null, 2)).catch(() => {});
  }
  return ok ? { ...ok, source: "wikipedia" } : null;
}

/** 座標・座標の無い記事は null、ネットや API の失敗は undefined。 */
async function askWikipedia(title: string, opts: GeocodeOptions): Promise<LonLat | null | undefined> {
  const url = `${WIKI_API}?action=query&prop=coordinates&titles=${encodeURIComponent(title)}&redirects=1&format=json&formatversion=2`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      console.warn(`[geocode] ${title}: Wikipedia HTTP ${res.status}`);
      return undefined;
    }
    const json = await res.json() as { query?: { pages?: Array<{ coordinates?: Array<{ lon?: number; lat?: number; globe?: string }> }> } };
    const pages = json?.query?.pages;
    if (!Array.isArray(pages)) return null;
    for (const p of pages) {
      for (const c of Array.isArray(p?.coordinates) ? p.coordinates : []) {
        if ((c?.globe ?? "earth") === "earth" && validLonLat(c?.lon, c?.lat)) return { lon: c.lon!, lat: c.lat! };
      }
    }
    return null;
  } catch (e) {
    console.warn(`[geocode] ${title}: Wikipedia failed (${e instanceof Error ? e.message : e})`);
    return undefined;
  }
}

async function loadCache(file: string): Promise<Cache> {
  const hit = caches.get(file);
  if (hit) return hit;
  let c: Cache = {};
  try {
    const v = JSON.parse(await fs.readFile(file, "utf-8"));
    if (v && typeof v === "object" && !Array.isArray(v)) c = v as Cache;
  } catch {
    // 無い・壊れている → 空から
  }
  caches.set(file, c);
  return c;
}

function validLonLat(lon: unknown, lat: unknown): boolean {
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)
    && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

/** 国の中心までの大圏距離 (km)。国の中心が分からなければ null。 */
export function distanceFromCountry(p: LonLat, countryCode: string): number | null {
  const c = countryCode ? countryLonLat(countryCode) : null;
  if (!c) return null;
  const rad = Math.PI / 180;
  const dLat = (p.lat - c[1]) * rad;
  const dLon = (p.lon - c[0]) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(c[1] * rad) * Math.cos(p.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
