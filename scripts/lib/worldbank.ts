/**
 * World Bank Indicators API v2 の薄いクライアント (鍵不要)。地図在庫づくり (scripts/build-map-library.ts) 用。
 * 値はここで API から取るだけで、加工 (丸め・ビン分け) は呼び出し側。
 */

const BASE = "https://api.worldbank.org/v2";
const TIMEOUT_MS = 60_000;
const TRIES = 3;

export interface WbIndicator {
  id: string;
  name: string;
  unit: string;
  sourceNote: string;
  sourceOrganization: string;
}

export interface WbEconomy {
  id: string;
  name: string;
  aggregate: boolean;
}

export interface WbLatest {
  value: number;
  year: number;
}

export interface WbSeries {
  code: string;
  lastUpdated: string | null;
  /** iso3 → 期間内で最も新しい非空値。集計地域 (iso3 が空のもの含む) もそのまま入る */
  latest: Map<string, WbLatest>;
  url: string;
}

interface PageMeta { page: number; pages: number; lastupdated?: string | null }

export function indicatorPageUrl(code: string): string {
  return `https://data.worldbank.org/indicator/${code}`;
}

async function getJson(url: string): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      // WB API はたまに 502/タイムアウトを返す。少し待って取り直す
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`World Bank API failed after ${TRIES} tries: ${url} (${last instanceof Error ? last.message : String(last)})`);
}

/** 不明な指標コードは [{ message: [...] }] の 1 要素配列で返る */
function unpack(json: unknown): { meta: PageMeta; rows: unknown[] } | null {
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) return null;
  return { meta: json[0] as PageMeta, rows: json[1] as unknown[] };
}

export async function fetchIndicator(code: string): Promise<WbIndicator | null> {
  const page = unpack(await getJson(`${BASE}/indicator/${encodeURIComponent(code)}?format=json`));
  const row = page?.rows[0] as Partial<WbIndicator> & { source?: unknown } | undefined;
  if (!row || row.id !== code) return null;
  return {
    id: code,
    name: String(row.name ?? "").trim(),
    unit: String(row.unit ?? "").trim(),
    sourceNote: String(row.sourceNote ?? "").trim(),
    sourceOrganization: String(row.sourceOrganization ?? "").trim(),
  };
}

export async function fetchEconomies(): Promise<Map<string, WbEconomy>> {
  const page = unpack(await getJson(`${BASE}/country?format=json&per_page=1000`));
  if (!page) throw new Error("World Bank /country returned no rows");
  const out = new Map<string, WbEconomy>();
  for (const r of page.rows as Array<{ id?: string; name?: string; region?: { value?: string } }>) {
    if (!r.id) continue;
    out.set(r.id.toUpperCase(), {
      id: r.id.toUpperCase(),
      name: String(r.name ?? "").trim(),
      aggregate: String(r.region?.value ?? "").trim() === "Aggregates",
    });
  }
  return out;
}

/**
 * fromYear..toYear の値を全部取り、経済ごとに最も新しい非空値を残す。
 * mrnev=1 は指標によって複数年を返すことがある (EG.ELC.ACCS.ZS で確認, 2026-11-01) ので年範囲で取って自前で選ぶ。
 */
export async function fetchLatestValues(code: string, fromYear: number, toYear: number): Promise<WbSeries> {
  const url = `${BASE}/country/all/indicator/${encodeURIComponent(code)}?format=json&per_page=20000&date=${fromYear}:${toYear}`;
  const latest = new Map<string, WbLatest>();
  let lastUpdated: string | null = null;
  for (let p = 1, pages = 1; p <= pages; p++) {
    const page = unpack(await getJson(`${url}&page=${p}`));
    if (!page) break;
    pages = Number(page.meta.pages) || 1;
    lastUpdated = page.meta.lastupdated ?? lastUpdated;
    for (const r of page.rows as Array<{ countryiso3code?: string; date?: string; value?: number | null }>) {
      const iso3 = String(r.countryiso3code ?? "").toUpperCase();
      const year = Number(r.date);
      if (!iso3 || typeof r.value !== "number" || !Number.isFinite(r.value) || !Number.isFinite(year)) continue;
      const prev = latest.get(iso3);
      if (!prev || year > prev.year) latest.set(iso3, { value: r.value, year });
    }
  }
  return { code, lastUpdated, latest, url };
}
