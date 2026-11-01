import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { fetchEconomies, fetchIndicator, fetchLatestValues, indicatorPageUrl, type WbEconomy } from "./lib/worldbank.js";

/**
 * 地図枠 (publish-map.ts) の在庫候補を作る。手順と確認の仕方: docs/map-library.md
 *
 *   npx tsx scripts/build-map-library.ts [--count 50]           Batch API で仕様を作り candidates.json を書く
 *   npx tsx scripts/build-map-library.ts --dry-run               API を呼ばない。依頼本文を表示し、先頭 3 件を機械的な仕様で組む
 *   npx tsx scripts/build-map-library.ts --spec-file specs.json  Claude を使わず、手書きの仕様から組む
 *   npx tsx scripts/build-map-library.ts --batch-id msgbatch_... 作成済みバッチの完了を待って続きから組む
 *   npx tsx scripts/build-map-library.ts --promote id1,id2      確認済みの候補を registry.json の末尾に足す (人が確認した後に使う)
 *   --out <path>  出力先 (既定 content/maps/candidates.json、--dry-run は output/map-library/candidates-dry-run.json)
 *   --from <path> --promote の読み元 (既定 content/maps/candidates.json)
 *   --poll-sec N  バッチの確認間隔 (既定 30)
 *
 * Claude が決めるのは見出し・凡例・ビンの切れ目・どのデータを使うかだけ。各国の値はこのスクリプトが
 * World Bank API / REST Countries から直接取り、Claude には分布の要約 (件数・パーセンタイル) しか渡さない。
 * 出力は registry.json と同じ形の `maps` (そのまま貼れる) と、人が確認するための `review` / `rejected`。
 */

const MODEL = "claude-opus-5-5";
const EFFORT = "medium" as const;
const MAX_TOKENS = 16000;
// Batch は標準 ($4 / $20 per MTok) の半額
const BATCH_USD_PER_MTOK = { input: 2, output: 10 };

const MIN_COUNTRIES = 150;
const MIN_PER_BIN = 8;
const MIN_YEAR = 2015;
const STALE_FROM_YEAR = 2000;
const DEFAULT_COUNT = 50;
const DRY_RUN_BUILD = 3;
const TITLE_MAX = 48;
const SHORT_TITLE_MAX = 70;
const CTA_MAX = 40;
const LABEL_MAX = 22;
const UNKNOWN_LABEL_MAX = 24;
const LOAD_CONCURRENCY = 6;

const REST_DATA_URL = "https://gitlab.com/restcountries/restcountries/-/raw/master/src/main/resources/countriesV3.1.json";
const REST_COMMITS_URL = "https://gitlab.com/api/v4/projects/restcountries%2Frestcountries/repository/commits?path=src/main/resources/countriesV3.1.json&per_page=1";
// 既存の REST 地図と同じく無人地域は塗らない
const NOT_DRAWN = new Set(["ATA", "BVT", "HMD"]);

// 既存の数値地図 (life-expectancy ほか) の 5 色。少ないビンでは両端と中間を使う
const NUMERIC_COLORS = ["#EF4444", "#F97316", "#FACC15", "#4ADE80", "#22D3EE"];
const NUMERIC_PICK: Record<number, number[]> = { 3: [0, 2, 4], 4: [0, 2, 3, 4], 5: [0, 1, 2, 3, 4] };
const CATEGORY_COLORS = ["#3B82F6", "#F59E0B", "#FF5A4E", "#22C55E", "#EC4899"];
const MUTED_COLOR = "#64748B";

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const MAPS_DIR = process.env.MAPS_DIR ? path.resolve(process.env.MAPS_DIR) : path.join(ROOT, "content", "maps");
const WORK_DIR = path.join(ROOT, "output", "map-library");
const PROMPT_PATH = path.join(ROOT, "prompts", "maps", "spec.md");

// ---------------------------------------------------------------- catalog

type RestKey = "borders" | "languages-count" | "official-eng" | "official-fra" | "official-spa" | "official-ara" | "official-por" | "postal-code";
type DatasetDef = { id: string; wb: string; hint?: string } | { id: string; rest: RestKey; hint?: string };

// 並び順 = 送る順 (--count はここから先頭 N 件)。登録済み・投稿済みの題材は実行時に除く
const CATALOG: DatasetDef[] = [
  { id: "fertility-rate", wb: "SP.DYN.TFRT.IN" },
  { id: "electricity-access", wb: "EG.ELC.ACCS.ZS" },
  { id: "english-official", rest: "official-eng" },
  { id: "urban-share", wb: "SP.URB.TOTL.IN.ZS" },
  { id: "population-density", wb: "EN.POP.DNST" },
  { id: "gdp-per-capita", wb: "NY.GDP.PCAP.CD" },
  { id: "over-65-share", wb: "SP.POP.65UP.TO.ZS" },
  { id: "land-borders", rest: "borders", hint: "Whole-number counts. Islands and countries with no land neighbour have 0." },
  { id: "under-15-share", wb: "SP.POP.0014.TO.ZS" },
  { id: "forest-cover", wb: "AG.LND.FRST.ZS" },
  { id: "mobile-subscriptions", wb: "IT.CEL.SETS.P2", hint: "Often above 100 because many people have more than one SIM card." },
  { id: "landline-subscriptions", wb: "IT.MLT.MAIN.P2" },
  { id: "official-languages-count", rest: "languages-count", hint: "Whole-number counts." },
  { id: "drinking-water", wb: "SH.H2O.BASW.ZS" },
  { id: "alcohol-consumption", wb: "SH.ALC.PCAP.LI" },
  { id: "women-in-parliament", wb: "SG.GEN.PARL.ZS" },
  { id: "spanish-official", rest: "official-spa" },
  { id: "migrant-share", wb: "SM.POP.TOTL.ZS" },
  { id: "co2-per-person", wb: "EN.GHG.CO2.PC.CE.AR5" },
  { id: "renewable-energy-share", wb: "EG.FEC.RNEW.ZS" },
  { id: "hydropower-share", wb: "EG.ELC.HYRO.ZS" },
  { id: "french-official", rest: "official-fra" },
  { id: "fossil-electricity-share", wb: "EG.ELC.FOSL.ZS" },
  { id: "annual-rainfall", wb: "AG.LND.PRCP.MM" },
  { id: "air-pollution-pm25", wb: "EN.ATM.PM25.MC.M3" },
  { id: "tobacco-use", wb: "SH.PRV.SMOK" },
  { id: "arabic-official", rest: "official-ara" },
  { id: "overweight-adults", wb: "SH.STA.OWAD.ZS" },
  { id: "doctors-per-1000", wb: "SH.MED.PHYS.ZS" },
  { id: "remittances-share-gdp", wb: "BX.TRF.PWKR.DT.GD.ZS" },
  { id: "female-population-share", wb: "SP.POP.TOTL.FE.ZS" },
  { id: "portuguese-official", rest: "official-por" },
  { id: "sex-ratio-at-birth", wb: "SP.POP.BRTH.MF", hint: "A ratio: 1.05 means 105 boys born per 100 girls." },
  { id: "fixed-broadband", wb: "IT.NET.BBND.P2" },
  { id: "university-enrollment", wb: "SE.TER.ENRR", hint: "Gross ratio: can be above 100% because students of any age are counted." },
  { id: "female-primary-teachers", wb: "SE.PRM.TCHR.FE.ZS" },
  { id: "postal-codes", rest: "postal-code" },
  { id: "pupils-per-teacher", wb: "SE.PRM.ENRL.TC.ZS" },
  { id: "clean-cooking-access", wb: "EG.CFT.ACCS.ZS" },
  { id: "basic-sanitation", wb: "SH.STA.BASS.ZS" },
  { id: "farm-jobs-share", wb: "SL.AGR.EMPL.ZS" },
  { id: "self-employed-share", wb: "SL.EMP.SELF.ZS" },
  { id: "women-in-workforce", wb: "SL.TLF.CACT.FE.ZS" },
  { id: "youth-unemployment", wb: "SL.UEM.1524.ZS" },
  { id: "unemployment-rate", wb: "SL.UEM.TOTL.ZS" },
  { id: "inflation-rate", wb: "FP.CPI.TOTL.ZG", hint: "Can be negative." },
  { id: "gdp-growth", wb: "NY.GDP.MKTP.KD.ZG", hint: "Can be negative." },
  { id: "trade-share-gdp", wb: "NE.TRD.GNFS.ZS" },
  { id: "fuel-exports-share", wb: "TX.VAL.FUEL.ZS.UN" },
  { id: "food-exports-share", wb: "TX.VAL.FOOD.ZS.UN" },
  { id: "oil-rents-share-gdp", wb: "NY.GDP.PETR.RT.ZS" },
  { id: "natural-resource-rents", wb: "NY.GDP.TOTL.RT.ZS" },
  { id: "manufacturing-share-gdp", wb: "NV.IND.MANF.ZS" },
  { id: "farming-share-gdp", wb: "NV.AGR.TOTL.ZS" },
  { id: "services-share-gdp", wb: "NV.SRV.TOTL.ZS" },
  { id: "military-spending-gdp", wb: "MS.MIL.XPND.GD.ZS" },
  { id: "health-spending-gdp", wb: "SH.XPD.CHEX.GD.ZS" },
  { id: "health-spending-per-person", wb: "SH.XPD.CHEX.PC.CD" },
  { id: "out-of-pocket-health", wb: "SH.XPD.OOPC.CH.ZS" },
  { id: "education-spending-gdp", wb: "SE.XPD.TOTL.GD.ZS" },
  { id: "hospital-beds", wb: "SH.MED.BEDS.ZS" },
  { id: "nurses-per-1000", wb: "SH.MED.NUMW.P3" },
  { id: "diabetes-prevalence", wb: "SH.STA.DIAB.ZS" },
  { id: "measles-vaccination", wb: "SH.IMM.MEAS" },
  { id: "road-deaths", wb: "SH.STA.TRAF.P5" },
  { id: "infant-mortality", wb: "SP.DYN.IMRT.IN" },
  { id: "protected-areas", wb: "ER.PTD.TOTL.ZS" },
  { id: "arable-land", wb: "AG.LND.ARBL.ZS" },
  { id: "farmland-share", wb: "AG.LND.AGRI.ZS" },
  { id: "freshwater-per-person", wb: "ER.H2O.INTR.PC" },
  { id: "cereal-yield", wb: "AG.YLD.CREL.KG" },
  { id: "air-passengers", wb: "IS.AIR.PSGR", hint: "Counted by the country where the airline is registered." },
  { id: "largest-city-share", wb: "EN.URB.LCTY.UR.ZS" },
  { id: "bank-account-ownership", wb: "FX.OWN.TOTL.ZS" },
  { id: "birth-rate", wb: "SP.DYN.CBRT.IN" },
  { id: "death-rate", wb: "SP.DYN.CDRT.IN" },
  { id: "population-growth", wb: "SP.POP.GROW", hint: "Can be negative." },
  { id: "new-business-density", wb: "IC.BUS.NDNS.ZS" },
  { id: "income-inequality-gini", wb: "SI.POV.GINI" },
  { id: "adult-literacy", wb: "SE.ADT.LITR.ZS" },
  { id: "undernourishment", wb: "SN.ITK.DEFC.ZS" },
  { id: "tuberculosis-incidence", wb: "SH.TBS.INCD" },
  { id: "current-account-balance", wb: "BN.CAB.XOKA.GD.ZS", hint: "Can be negative." },
  { id: "primary-completion", wb: "SE.PRM.CMPT.ZS" },
  { id: "secondary-enrollment", wb: "SE.SEC.ENRR", hint: "Gross ratio: can be above 100%." },
];

interface RestCountry {
  cca3?: string;
  ccn3?: string;
  borders?: string[];
  languages?: Record<string, string>;
  postalCode?: { format?: string | null };
}

const LANG_NAMES: Record<string, string> = { eng: "English", fra: "French", spa: "Spanish", ara: "Arabic", por: "Portuguese" };

function restDef(key: RestKey): { field: string; name: string; definition: string; kind: "numeric" | "categorical"; get: (c: RestCountry) => number | string } {
  if (key === "borders") return {
    field: "borders", kind: "numeric",
    name: "Number of countries and territories it shares a land border with",
    definition: "Count of the entries in REST Countries' borders field (land borders only). Islands and places with no land neighbour have 0.",
    get: c => (c.borders ?? []).length,
  };
  if (key === "languages-count") return {
    field: "languages, count", kind: "numeric",
    name: "Number of official languages",
    definition: "Count of the languages listed in REST Countries' languages field (its list of official languages) for each country or territory.",
    get: c => Object.keys(c.languages ?? {}).length,
  };
  if (key === "postal-code") return {
    field: "postalCode", kind: "categorical",
    name: "Whether the country or territory uses a postal code format",
    definition: "yes = REST Countries lists a postal code format (postalCode.format); no = it lists none.",
    get: c => (c.postalCode?.format ? "yes" : "no"),
  };
  const lang = key.slice("official-".length);
  return {
    field: `languages: ${lang}`, kind: "categorical",
    name: `Whether ${LANG_NAMES[lang]} is an official language`,
    definition: `yes = ${LANG_NAMES[lang]} (${lang}) is in REST Countries' languages field (its list of official languages); no = it is not.`,
    get: c => (c.languages && lang in c.languages ? "yes" : "no"),
  };
}

// ---------------------------------------------------------------- data

interface MapLegend { key: string; label: string; color: string }
interface MapEntry {
  id: string;
  title: string;
  shortTitle: string;
  cta: string;
  descriptionNote?: string;
  legend: MapLegend[];
  data: Record<string, string>;
  raw?: Record<string, number>;
  unknownLabel: string;
  source: { name: string; url: string; year: number; fetchedAt: string };
  notes: string;
  durationSec: number;
}
interface Registry { maps: Array<{ id: string; source?: { name?: string; url?: string } }> }

interface Loaded {
  id: string;
  kind: "numeric" | "categorical";
  name: string;
  definition: string;
  hint?: string;
  topic: string;
  source: { name: string; url: string; year: number };
  dataUrl: string;
  lastUpdated: string | null;
  /** API の値そのまま (丸めない)。ビン分けはこの値で行う */
  values: Map<string, number | string>;
  years: Map<string, number>;
  integer: boolean;
  /** WB の経済のうち countries.json に ccn3 が無く描けないもの (XKX, CHI) */
  dropped: string[];
  /** 2015 年より前の値しか無く、使わなかったもの */
  stale: Array<{ id: string; year: number }>;
}

interface Ctx {
  date: string;
  thisYear: number;
  drawable: Set<string>;
  names: Map<string, string>;
  usedIds: Set<string>;
  usedTopics: string[];
  economies?: Map<string, WbEconomy>;
  rest?: { list: RestCountry[]; updated: string | null };
}

async function loadContext(): Promise<Ctx> {
  const registry: Registry = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "registry.json"), "utf-8"));
  const posted: { posted?: Array<{ id: string }> } = await fs.readFile(path.join(MAPS_DIR, "posted.json"), "utf-8").then(JSON.parse).catch(() => ({}));
  const parsed = JSON.parse(await fs.readFile(path.join(MAPS_DIR, "countries.json"), "utf-8"));
  const countries: Array<{ cca3: string; ccn3?: string; name?: { common?: string } }> = Array.isArray(parsed) ? parsed : parsed.countries ?? [];
  const drawable = new Set(countries.filter(c => c.cca3 && c.ccn3 && !NOT_DRAWN.has(c.cca3.toUpperCase())).map(c => c.cca3.toUpperCase()));
  const names = new Map(countries.map(c => [c.cca3.toUpperCase(), c.name?.common ?? c.cca3]));
  const usedIds = new Set([...(registry.maps ?? []).map(m => m.id), ...(posted.posted ?? []).map(p => p.id)]);
  const usedTopics = (registry.maps ?? []).map(m => `${m.source?.name ?? ""} ${m.source?.url ?? ""}`);
  const now = new Date();
  return { date: now.toISOString().slice(0, 10), thisYear: now.getUTCFullYear(), drawable, names, usedIds, usedTopics };
}

function topicOf(def: DatasetDef): string {
  return "wb" in def ? def.wb : `(${restDef(def.rest).field})`;
}

function alreadyUsed(def: DatasetDef, ctx: Ctx): string | null {
  if (ctx.usedIds.has(def.id)) return `id "${def.id}" is already in registry.json/posted.json`;
  const topic = topicOf(def);
  const hit = ctx.usedTopics.find(t => t.includes(topic));
  return hit ? `topic ${topic} is already used in registry.json (${hit.trim()})` : null;
}

const sig = (v: number, digits: number) => Number(v.toPrecision(digits));

async function loadDataset(def: DatasetDef, ctx: Ctx): Promise<Loaded | { id: string; reason: string }> {
  if ("wb" in def) {
    const meta = await fetchIndicator(def.wb);
    if (!meta) return { id: def.id, reason: `unknown World Bank indicator code ${def.wb} (api.worldbank.org/v2/indicator returned no match)` };
    ctx.economies ??= await fetchEconomies();
    const series = await fetchLatestValues(def.wb, STALE_FROM_YEAR, ctx.thisYear);
    const values = new Map<string, number | string>();
    const years = new Map<string, number>();
    const dropped: string[] = [];
    const stale: Array<{ id: string; year: number }> = [];
    for (const [iso3, v] of series.latest) {
      const eco = ctx.economies.get(iso3);
      if (!eco || eco.aggregate) continue;
      if (!ctx.drawable.has(iso3)) { dropped.push(iso3); continue; }
      if (v.year < MIN_YEAR) { stale.push({ id: iso3, year: v.year }); continue; }
      values.set(iso3, v.value);
      years.set(iso3, v.year);
    }
    const modal = modeOf([...years.values()]) ?? ctx.thisYear;
    return {
      id: def.id, kind: "numeric", name: meta.name, definition: meta.sourceNote, hint: def.hint, topic: def.wb,
      source: { name: `World Bank (${def.wb})`, url: indicatorPageUrl(def.wb), year: modal },
      dataUrl: series.url, lastUpdated: series.lastUpdated, values, years,
      integer: [...values.values()].every(v => Number.isInteger(v)),
      dropped: dropped.sort(), stale: stale.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  ctx.rest ??= await loadRest();
  const rd = restDef(def.rest);
  const values = new Map<string, number | string>();
  for (const c of ctx.rest.list) {
    const cca3 = String(c.cca3 ?? "").toUpperCase();
    if (ctx.drawable.has(cca3)) values.set(cca3, rd.get(c));
  }
  const year = ctx.rest.updated ? Number(ctx.rest.updated.slice(0, 4)) : ctx.thisYear;
  return {
    id: def.id, kind: rd.kind, name: rd.name, definition: rd.definition, hint: def.hint, topic: rd.field,
    source: { name: `REST Countries v3.1 (${rd.field})`, url: "https://restcountries.com/", year },
    dataUrl: REST_DATA_URL, lastUpdated: ctx.rest.updated, values, years: new Map(),
    integer: rd.kind === "numeric", dropped: [], stale: [],
  };
}

async function loadRest(): Promise<{ list: RestCountry[]; updated: string | null }> {
  const res = await fetch(REST_DATA_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`REST Countries data file: HTTP ${res.status}`);
  const list = await res.json() as RestCountry[];
  // 最終更新日は出典の年に使うだけなので、取れなくても止めない
  const updated = await fetch(REST_COMMITS_URL, { signal: AbortSignal.timeout(30_000) })
    .then(r => (r.ok ? r.json() : []))
    .then((j: Array<{ created_at?: string }>) => j[0]?.created_at?.slice(0, 10) ?? null)
    .catch(() => null);
  return { list, updated };
}

async function loadAll(defs: DatasetDef[], ctx: Ctx): Promise<{ loaded: Loaded[]; failed: Rejected[] }> {
  const loaded: Loaded[] = [];
  const failed: Rejected[] = [];
  const results = new Array<Loaded | { id: string; reason: string }>(defs.length);
  let next = 0;
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, async () => {
    while (next < defs.length) {
      const i = next++;
      try {
        results[i] = await loadDataset(defs[i], ctx);
      } catch (e) {
        results[i] = { id: defs[i].id, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }));
  for (const r of results) {
    if ("reason" in r) { failed.push({ id: r.id, stage: "fetch", reason: r.reason }); continue; }
    const pre = precheck(r);
    if (pre) failed.push({ id: r.id, stage: "precheck", reason: pre });
    else loaded.push(r);
  }
  return { loaded, failed };
}

function precheck(ds: Loaded): string | null {
  if (ds.values.size < MIN_COUNTRIES) return `only ${ds.values.size} countries with a value from ${MIN_YEAR} on (< ${MIN_COUNTRIES})`;
  const distinct = new Set(ds.values.values()).size;
  if (ds.kind === "numeric" && distinct < 3) return `only ${distinct} distinct values`;
  if (ds.kind === "categorical" && distinct < 2) return "only one category";
  return null;
}

function modeOf(xs: number[]): number | undefined {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.round(p * (sorted.length - 1))];
}

function yearHistogram(ds: Loaded): Record<string, number> {
  const h: Record<string, number> = {};
  for (const y of ds.years.values()) h[y] = (h[y] ?? 0) + 1;
  return h;
}

function describeYears(ds: Loaded): string {
  const h = yearHistogram(ds);
  return Object.entries(h).sort((a, b) => Number(b[0]) - Number(a[0])).map(([y, n]) => `${y} ×${n}`).join(", ");
}

/** Claude に渡すのはここまで。国ごとの値は渡さない */
function summarize(ds: Loaded): string {
  if (ds.kind === "categorical") {
    const counts = new Map<string, number>();
    for (const v of ds.values.values()) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    return `Category values (value: number of countries and territories): ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `"${v}": ${n}`).join(", ")}`;
  }
  const sorted = [...ds.values.values()].map(Number).sort((a, b) => a - b);
  const q = (p: number) => sig(quantile(sorted, p), 3);
  return `Distribution: minimum ${q(0)} · 10th percentile ${q(0.1)} · 25th ${q(0.25)} · median ${q(0.5)} · 75th ${q(0.75)} · 90th ${q(0.9)} · maximum ${q(1)}`;
}

function userMessage(ds: Loaded): string {
  const src = ds.source.name.startsWith("REST")
    ? `REST Countries v3.1 data file (${ds.topic})`
    : `World Bank, World Development Indicators, indicator ${ds.topic}`;
  const coverage = ds.years.size
    ? `${ds.values.size} (latest value per economy from ${MIN_YEAR} on; years: ${describeYears(ds)})`
    : `${ds.values.size}`;
  return [
    `Dataset id: ${ds.id}`,
    `Source: ${src}`,
    `Name: ${ds.name}`,
    `Definition: ${ds.definition.slice(0, 1500) || "(none given)"}`,
    `Kind: ${ds.kind === "categorical" ? "categories" : ds.integer ? "numeric (whole numbers)" : "numeric (decimal numbers)"}`,
    `Countries and territories with a value: ${coverage}`,
    summarize(ds),
    ...(ds.hint ? [`Note: ${ds.hint}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------- spec

interface MapSpec {
  dataset: string;
  id?: string;
  skip: boolean;
  skipReason: string;
  title: string;
  shortTitle: string;
  cta: string;
  unknownLabel: string;
  descriptionNote: string;
  bins: Array<{ max: number | null; label: string }>;
  groups: Array<{ values: string[]; label: string; muted: boolean }>;
}

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skip", "skipReason", "title", "shortTitle", "cta", "unknownLabel", "descriptionNote", "bins", "groups"],
  properties: {
    skip: { type: "boolean" },
    skipReason: { type: "string" },
    title: { type: "string", description: `UPPERCASE, at most ${TITLE_MAX} characters` },
    shortTitle: { type: "string", description: `Title case, at most ${SHORT_TITLE_MAX} characters` },
    cta: { type: "string", description: `At most ${CTA_MAX} characters, ends with one emoji` },
    unknownLabel: { type: "string" },
    descriptionNote: { type: "string" },
    bins: {
      type: "array",
      description: "Numeric datasets only (empty for categories). Ascending; value < max goes in the bin; last bin max is null.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["max", "label"],
        properties: { max: { anyOf: [{ type: "number" }, { type: "null" }] }, label: { type: "string" } },
      },
    },
    groups: {
      type: "array",
      description: "Category datasets only (empty for numeric). Every category value in exactly one group.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["values", "label", "muted"],
        properties: { values: { type: "array", items: { type: "string" } }, label: { type: "string" }, muted: { type: "boolean" } },
      },
    },
  },
} as const;

function parseSpec(raw: unknown, dataset: string): MapSpec {
  if (!raw || typeof raw !== "object") throw new Error("spec is not an object");
  const o = raw as Record<string, unknown>;
  const str = (k: string, def = "") => {
    const v = o[k] ?? def;
    if (typeof v !== "string") throw new Error(`${k} must be a string`);
    return v.trim();
  };
  const bins = (o.bins ?? []) as unknown[];
  const groups = (o.groups ?? []) as unknown[];
  if (!Array.isArray(bins) || !Array.isArray(groups)) throw new Error("bins and groups must be arrays");
  return {
    dataset,
    id: typeof o.id === "string" ? o.id : undefined,
    skip: o.skip === true,
    skipReason: str("skipReason"),
    title: str("title"),
    shortTitle: str("shortTitle"),
    cta: str("cta"),
    unknownLabel: str("unknownLabel", "No data") || "No data",
    descriptionNote: str("descriptionNote"),
    bins: bins.map((b, i) => {
      const bb = b as { max?: unknown; label?: unknown };
      if (!(bb.max === null || bb.max === undefined || typeof bb.max === "number")) throw new Error(`bins[${i}].max must be a number or null`);
      if (typeof bb.label !== "string") throw new Error(`bins[${i}].label must be a string`);
      return { max: typeof bb.max === "number" ? bb.max : null, label: bb.label.trim() };
    }),
    groups: groups.map((g, i) => {
      const gg = g as { values?: unknown; label?: unknown; muted?: unknown };
      if (!Array.isArray(gg.values) || typeof gg.label !== "string") throw new Error(`groups[${i}] needs values[] and label`);
      return { values: gg.values.map(String), label: gg.label.trim(), muted: gg.muted === true };
    }),
  };
}

/** "Under 1M" → [1000000], "10k–100k" → [10000, 100000], "-2% to 0%" → [-2, 0]。範囲のダッシュは負号にしない */
function numbersInLabel(s: string): number[] {
  // NFKC は掛けない ("km²" の ² が 2 になる)
  const t = s.replace(/−/g, "-");
  const out: number[] = [];
  const re = /(-?)(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(thousand|million|billion|bn|k|K|M|B)(?![A-Za-z]))?/g;
  for (const m of t.matchAll(re)) {
    const before = t[m.index! - 1] ?? "";
    const negative = m[1] === "-" && !/[\d%A-Za-z.]/.test(before);
    const scale = { thousand: 1e3, k: 1e3, K: 1e3, million: 1e6, M: 1e6, billion: 1e9, bn: 1e9, B: 1e9 }[m[3] ?? ""] ?? 1;
    out.push((negative ? -1 : 1) * Number(m[2].replace(/,/g, "")) * scale);
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function fmtEdge(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9 && n % 1e8 === 0) return `${n / 1e9}B`;
  if (a >= 1e6 && n % 1e5 === 0) return `${n / 1e6}M`;
  if (a >= 1e3 && n % 100 === 0) return `${n / 1e3}k`;
  return String(n);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
}

interface Rejected { id: string; stage: "fetch" | "precheck" | "claude" | "checks" | "skipped-by-model"; reason: string }
interface Review {
  id: string;
  kind: Loaded["kind"];
  promptSummary: string;
  spec: MapSpec;
  counts: Record<string, number>;
  coverage: number;
  years: Record<string, number>;
  warnings: string[];
}

function buildCandidate(ds: Loaded, spec: MapSpec, ctx: Ctx, provenance: string): { entry: MapEntry; review: Review } | Rejected {
  const id = spec.id ?? ds.id;
  const fail = (reason: string, stage: Rejected["stage"] = "checks"): Rejected => ({ id, stage, reason });
  if (spec.skip) return fail(spec.skipReason || "(no reason given)", "skipped-by-model");

  const problems: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) problems.push(`id "${id}" is not kebab-case`);
  if (ctx.usedIds.has(id)) problems.push(`id "${id}" is already in registry.json/posted.json`);
  if (!spec.title || spec.title !== spec.title.toUpperCase()) problems.push("title must be UPPERCASE");
  if (spec.title.length > TITLE_MAX) problems.push(`title is ${spec.title.length} chars (> ${TITLE_MAX})`);
  if (!spec.shortTitle || spec.shortTitle.length > SHORT_TITLE_MAX) problems.push(`shortTitle must be 1–${SHORT_TITLE_MAX} chars`);
  if (!spec.cta || spec.cta.length > CTA_MAX) problems.push(`cta must be 1–${CTA_MAX} chars`);
  if (!/\p{Extended_Pictographic}/u.test(spec.cta)) problems.push("cta has no emoji");
  if (!spec.unknownLabel || spec.unknownLabel.length > UNKNOWN_LABEL_MAX) problems.push(`unknownLabel must be 1–${UNKNOWN_LABEL_MAX} chars`);

  let legend: MapLegend[] = [];
  let keyOf: (v: number | string) => string | undefined;
  const edges: number[] = [];
  if (ds.kind === "numeric") {
    const bins = spec.bins;
    if (bins.length < 3 || bins.length > 5) problems.push(`need 3–5 bins (got ${bins.length})`);
    if (spec.groups.length) problems.push("numeric dataset must not have groups");
    bins.forEach((b, i) => {
      if (i < bins.length - 1 && b.max === null) problems.push(`bins[${i}].max is null but is not the last bin`);
      if (i === bins.length - 1 && b.max !== null) problems.push("last bin must have max null");
      if (b.max !== null) edges.push(b.max);
    });
    if (edges.some((e, i) => i > 0 && e <= edges[i - 1])) problems.push("bin edges must be strictly increasing");
    const colors = NUMERIC_PICK[bins.length] ?? [];
    legend = bins.map((b, i) => {
      const lo = i > 0 ? edges[i - 1] : undefined;
      const hi = i < edges.length ? edges[i] : undefined;
      const allowed = [lo, hi, ...(hi !== undefined && ds.integer ? [hi - 1] : []), ...(i === 0 ? [0] : [])].filter((x): x is number => x !== undefined);
      const bad = numbersInLabel(b.label).filter(n => !allowed.some(a => near(a, n)));
      if (bad.length) problems.push(`label "${b.label}" has ${bad.join(", ")} which is not an edge of its bin (${lo ?? "−∞"}, ${hi ?? "∞"})`);
      const key = i === 0 ? `<${fmtEdge(edges[0])}` : hi === undefined ? `${fmtEdge(lo!)}+` : `${fmtEdge(lo!)}-${fmtEdge(hi)}`;
      return { key, label: b.label, color: NUMERIC_COLORS[colors[i] ?? 0] };
    });
    keyOf = v => {
      const n = Number(v);
      const i = edges.findIndex(e => n < e);
      return legend[i === -1 ? legend.length - 1 : i]?.key;
    };
  } else {
    const groups = spec.groups;
    if (groups.length < 2 || groups.length > 5) problems.push(`need 2–5 groups (got ${groups.length})`);
    if (spec.bins.length) problems.push("category dataset must not have bins");
    const distinct = new Set([...ds.values.values()].map(String));
    const owner = new Map<string, number>();
    groups.forEach((g, gi) => g.values.forEach(v => {
      if (!distinct.has(v)) problems.push(`group "${g.label}" lists unknown value "${v}"`);
      if (owner.has(v)) problems.push(`value "${v}" is in more than one group`);
      owner.set(v, gi);
    }));
    for (const v of distinct) if (!owner.has(v)) problems.push(`value "${v}" is not in any group`);
    if (groups.filter(g => g.muted).length > 1) problems.push("at most one group may be muted");
    const keys = new Set<string>();
    let c = 0;
    legend = groups.map(g => {
      let key = slug(g.label);
      while (keys.has(key)) key = `${key}-x`;
      keys.add(key);
      return { key, label: g.label, color: g.muted ? MUTED_COLOR : CATEGORY_COLORS[c++ % CATEGORY_COLORS.length] };
    });
    keyOf = v => legend[owner.get(String(v)) ?? -1]?.key;
  }
  const labels = legend.map(l => l.label);
  if (labels.some(l => !l || l.length > LABEL_MAX)) problems.push(`legend labels must be 1–${LABEL_MAX} chars`);
  if (new Set(labels).size !== labels.length) problems.push("legend labels must be unique");

  // 本文に出る数は、定義・指標名・ビンの切れ目・年に出てくるものだけ (Claude は国の値を知らない)
  const years = [...ds.years.values()];
  const allowedNums = [...numbersInLabel(`${ds.name} ${ds.definition}`), ...edges, ...years, ctx.thisYear, 0, 1, 100];
  for (const [field, text] of [["title", spec.title], ["shortTitle", spec.shortTitle], ["cta", spec.cta], ["descriptionNote", spec.descriptionNote]] as const) {
    const bad = numbersInLabel(text).filter(n => !allowedNums.some(a => near(a, n)));
    if (bad.length) problems.push(`${field} has number(s) ${bad.join(", ")} not found in the dataset definition or bin edges`);
  }
  if (problems.length) return fail(problems.join("; "));

  const data: Record<string, string> = {};
  const raw: Record<string, number> = {};
  const counts: Record<string, number> = Object.fromEntries(legend.map(l => [l.key, 0]));
  for (const cca3 of [...ds.values.keys()].sort()) {
    const v = ds.values.get(cca3)!;
    const key = keyOf(v);
    if (!key) return fail(`no legend key for ${cca3}=${v}`);
    data[cca3] = key;
    if (ds.kind === "numeric") raw[cca3] = sig(Number(v), 4);
    counts[key] += 1;
  }
  const coverage = Object.keys(data).length;
  const small = legend.filter(l => counts[l.key] < MIN_PER_BIN);
  if (coverage < MIN_COUNTRIES) return fail(`coverage ${coverage} < ${MIN_COUNTRIES}`);
  if (small.length) return fail(`bins with fewer than ${MIN_PER_BIN} countries: ${small.map(l => `${l.label}=${counts[l.key]}`).join(", ")}`);

  const warnings: string[] = [];
  const largest = Math.max(...Object.values(counts));
  if (largest / coverage > 0.6) warnings.push(`one colour covers ${Math.round((100 * largest) / coverage)}% of countries`);
  const yh = yearHistogram(ds);
  const minY = years.length ? Math.min(...years) : undefined;
  const maxY = years.length ? Math.max(...years) : undefined;
  if (maxY !== undefined && ds.source.year < ctx.thisYear - 5) warnings.push(`most values are from ${ds.source.year}`);
  const mixedYears = years.length > 0 && (yh[ds.source.year] ?? 0) / years.length < 0.9;

  const note = [spec.descriptionNote, mixedYears ? `Latest available year per economy (${minY}–${maxY}).` : ""].filter(Boolean).join(" ");
  const entry: MapEntry = {
    id,
    title: spec.title,
    shortTitle: spec.shortTitle,
    cta: spec.cta,
    ...(note ? { descriptionNote: note } : {}),
    legend,
    data,
    ...(ds.kind === "numeric" ? { raw } : {}),
    unknownLabel: spec.unknownLabel,
    source: { ...ds.source, fetchedAt: ctx.date },
    notes: buildNotes(ds, legend, counts, coverage, ctx, provenance, warnings),
    durationSec: 7,
  };
  return { entry, review: { id, kind: ds.kind, promptSummary: userMessage(ds), spec, counts, coverage, years: yh, warnings } };
}

function buildNotes(ds: Loaded, legend: MapLegend[], counts: Record<string, number>, coverage: number, ctx: Ctx, provenance: string, warnings: string[]): string {
  const parts = [
    `auto-built ${ctx.date} by scripts/build-map-library.ts — ${provenance}`,
    `Values fetched by the script from ${ds.dataUrl}${ds.lastUpdated ? ` (source lastupdated ${ds.lastUpdated})` : ""}; the model never saw per-country values.`,
    `automated checks passed: coverage ${coverage} >= ${MIN_COUNTRIES}; every bin >= ${MIN_PER_BIN} (${legend.map(l => `${l.key}=${counts[l.key]}`).join(", ")}); legend numbers match bin edges; title/CTA numbers only from the definition or edges.`,
  ];
  if (ds.years.size) {
    parts.push(`Latest non-empty value per economy, ${MIN_YEAR} or later: years ${JSON.stringify(yearHistogram(ds))}; source.year = modal year.`);
    parts.push(ds.stale.length
      ? `Not used (latest value before ${MIN_YEAR}, shown as No data): ${ds.stale.map(s => `${s.id}:${s.year}`).join(", ")}.`
      : `No economy was dropped for being older than ${MIN_YEAR}.`);
    parts.push(`World Bank aggregates dropped${ds.dropped.length ? `; no ccn3 in countries.json so not drawable: ${ds.dropped.join(", ")}` : ""}.`);
  }
  if (ds.kind === "numeric") {
    const sorted = [...ds.values.entries()].map(([k, v]) => [k, sig(Number(v), 4)] as const).sort((a, b) => b[1] - a[1]);
    const show = (xs: ReadonlyArray<readonly [string, number]>) => xs.map(([k, v]) => `${k} ${v}`).join(", ");
    parts.push(`raw = ${ds.name}, to 4 significant digits; bins use the unrounded API value. Highest: ${show(sorted.slice(0, 3))}; lowest: ${show(sorted.slice(-3).reverse())}.`);
  }
  if (ds.source.name.startsWith("REST")) parts.push(`REST Countries data file last updated ${ds.lastUpdated ?? "unknown"}; REST has known stale entries (see driving-side/timezones notes) — spot-check before promoting.`);
  if (warnings.length) parts.push(`warnings: ${warnings.join("; ")}.`);
  parts.push("NOT yet human-verified: spot-check 3 countries against the source before moving this entry into registry.json.");
  return parts.join(" ");
}

/** --dry-run 用。Claude の代わりに五分位から機械的に作る (データ経路の確認用で、そのまま採用しない) */
function mechanicalSpec(ds: Loaded): MapSpec {
  const base = ds.name.toUpperCase().replace(/\s*\(.*\)\s*$/, "");
  const title = base.length > TITLE_MAX ? base.slice(0, TITLE_MAX).trimEnd() : base;
  const common = {
    dataset: ds.id, skip: false, skipReason: "", title, shortTitle: `[dry-run] ${ds.id}`, cta: "Your country? 👇",
    unknownLabel: "No data", descriptionNote: "",
  };
  if (ds.kind === "categorical") {
    const vals = [...new Set([...ds.values.values()].map(String))].sort();
    return { ...common, bins: [], groups: vals.map(v => ({ values: [v], label: v, muted: v === "no" })) };
  }
  const sorted = [...ds.values.values()].map(Number).sort((a, b) => a - b);
  const nice = (x: number) => {
    if (x === 0) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(Math.abs(x))) - 1);
    return Math.round(x / p) * p;
  };
  const edges = [...new Set([0.2, 0.4, 0.6, 0.8].map(p => Number(nice(quantile(sorted, p)).toPrecision(12))))]
    .filter(e => e > sorted[0] && e <= sorted[sorted.length - 1]);
  const lab = (n: number) => fmtEdge(n);
  const bins = [
    { max: edges[0], label: `Under ${lab(edges[0])}` },
    ...edges.slice(1).map((e, i) => ({ max: e, label: `${lab(edges[i])}–${lab(e)}` })),
    { max: null, label: `${lab(edges[edges.length - 1])}+` },
  ];
  return { ...common, bins, groups: [] };
}

// ---------------------------------------------------------------- batch

type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;

function buildRequest(ds: Loaded, system: string): BatchRequest {
  return {
    custom_id: ds.id,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: SPEC_SCHEMA } },
      system,
      messages: [{ role: "user", content: userMessage(ds) }],
    },
  };
}

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
const costUsd = (u: Usage) => ((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * BATCH_USD_PER_MTOK.input + u.output * BATCH_USD_PER_MTOK.output) / 1e6;

async function waitForBatch(client: Anthropic, batchId: string, pollSec: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const b = await client.messages.batches.retrieve(batchId);
    const c = b.request_counts;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`[maps] ${b.id} ${b.processing_status} — processing ${c.processing}, succeeded ${c.succeeded}, errored ${c.errored}, expired ${c.expired}, canceled ${c.canceled} (${mins} min)`);
    if (b.processing_status === "ended") return;
    await new Promise(r => setTimeout(r, pollSec * 1000));
  }
}

async function collectResults(client: Anthropic, batchId: string): Promise<{ specs: Map<string, MapSpec>; failed: Rejected[]; usage: Usage }> {
  const specs = new Map<string, MapSpec>();
  const failed: Rejected[] = [];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  for await (const r of await client.messages.batches.results(batchId)) {
    const fail = (reason: string) => failed.push({ id: r.custom_id, stage: "claude", reason });
    if (r.result.type === "errored") { fail(`errored: ${r.result.error.error.type} — ${r.result.error.error.message}`); continue; }
    if (r.result.type === "expired") { fail("expired before processing (24h limit) — re-run to resubmit"); continue; }
    if (r.result.type === "canceled") { fail("canceled"); continue; }
    const msg = r.result.message;
    usage.requests += 1;
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    // Batch では server-side fallback が使えないので、拒否はここで落とすだけ (再投入は人の判断)
    if (msg.stop_reason === "refusal") { fail(`refusal (${msg.stop_details?.category ?? "no category"})`); continue; }
    if (msg.stop_reason === "max_tokens") { fail(`hit max_tokens (${MAX_TOKENS})`); continue; }
    const text = msg.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
    try {
      specs.set(r.custom_id, parseSpec(JSON.parse(text), r.custom_id));
    } catch (e) {
      fail(`unparseable spec: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { specs, failed, usage };
}

// ---------------------------------------------------------------- main

interface Args { dryRun: boolean; count: number; specFile?: string; batchId?: string; out?: string; pollSec: number; promote?: string[]; from?: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, count: DEFAULT_COUNT, pollSec: 30 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--count") a.count = Number(val());
    else if (k === "--spec-file") a.specFile = val();
    else if (k === "--batch-id") a.batchId = val();
    else if (k === "--out") a.out = val();
    else if (k === "--poll-sec") a.pollSec = Number(val());
    else if (k === "--promote") a.promote = val().split(",").map(x => x.trim()).filter(Boolean);
    else if (k === "--from") a.from = val();
    else throw new Error(`unknown argument ${k}`);
  }
  if (!Number.isInteger(a.count) || a.count < 1) throw new Error("--count must be a positive integer");
  if (!(a.pollSec > 0)) throw new Error("--poll-sec must be > 0");
  if ([a.dryRun, a.specFile, a.batchId, a.promote].filter(Boolean).length > 1) throw new Error("use only one of --dry-run, --spec-file, --batch-id, --promote");
  return a;
}

function defById(id: string): DatasetDef | undefined {
  if (id.startsWith("wb:")) return { id: "", wb: id.slice(3) };
  return CATALOG.find(d => d.id === id);
}

/** registry.json と同じ書式 (2 字下げ・data / raw は 1 行)。貼り替えても既存行の差分が出ない */
function formatMapsJson(doc: unknown): string {
  const inline: string[] = [];
  const json = JSON.stringify(doc, (key, value) => {
    if ((key === "data" || key === "raw") && value && typeof value === "object" && !Array.isArray(value)) {
      inline.push(`{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`);
      return `__INLINE_${inline.length - 1}__`;
    }
    return value;
  }, 2);
  return json.replace(/"__INLINE_(\d+)__"/g, (_, i) => inline[Number(i)]) + "\n";
}

async function promote(ids: string[], from: string | undefined, ctx: Ctx): Promise<void> {
  const candPath = from ? path.resolve(from) : path.join(MAPS_DIR, "candidates.json");
  const cand = JSON.parse(await fs.readFile(candPath, "utf-8")) as { mode?: string; maps?: MapEntry[] };
  if (cand.mode === "dry-run") throw new Error(`${candPath} is a dry run (mechanical specs) — not promotable`);
  const regPath = path.join(MAPS_DIR, "registry.json");
  const registry = JSON.parse(await fs.readFile(regPath, "utf-8")) as { maps: unknown[] };
  for (const id of ids) {
    const m = cand.maps?.find(x => x.id === id);
    if (!m) throw new Error(`"${id}" is not in ${candPath} (maps)`);
    if (ctx.usedIds.has(id)) throw new Error(`"${id}" is already in registry.json/posted.json`);
    registry.maps.push({ ...m, notes: m.notes.replace(/ ?NOT yet human-verified:.*$/, ` Promoted ${ctx.date} with --promote after human review.`) });
    ctx.usedIds.add(id);
  }
  await fs.writeFile(regPath, formatMapsJson(registry), "utf-8");
  console.log(`[maps] registry.json: +${ids.join(", ")} (total ${registry.maps.length}). publish-map.ts auto picks the first unposted entry in registry order.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await loadContext();
  if (args.promote) return promote(args.promote, args.from, ctx);
  const rejected: Rejected[] = [];
  let mode: "batch" | "spec-file" | "dry-run";
  let defs: DatasetDef[];
  let specs = new Map<string, MapSpec>();
  let batchId: string | undefined;
  let usage: Usage | undefined;
  let provenance: (spec: MapSpec) => string;

  if (args.specFile) {
    mode = "spec-file";
    const rawFile = JSON.parse(await fs.readFile(path.resolve(args.specFile), "utf-8"));
    const list: unknown[] = Array.isArray(rawFile) ? rawFile : rawFile.specs ?? [];
    defs = [];
    for (const item of list) {
      const dataset = String((item as { dataset?: unknown }).dataset ?? "");
      const def = defById(dataset);
      const spec = parseSpec(item, dataset);
      if (!def) { rejected.push({ id: dataset || "(missing)", stage: "fetch", reason: `dataset "${dataset}" is not in the catalog (use a catalog id or "wb:<CODE>" with an "id")` }); continue; }
      if (!def.id) {
        if (!spec.id) { rejected.push({ id: dataset, stage: "fetch", reason: `"${dataset}" needs an "id"` }); continue; }
        def.id = spec.id;
      }
      const used = alreadyUsed(def, ctx);
      if (used) { rejected.push({ id: def.id, stage: "precheck", reason: used }); continue; }
      specs.set(def.id, { ...spec, dataset: def.id });
      defs.push(def);
    }
    provenance = () => `spec from ${path.relative(ROOT, path.resolve(args.specFile!))} (handwritten, no Claude call).`;
  } else if (args.batchId) {
    mode = "batch";
    batchId = args.batchId;
    const client = new Anthropic();
    await waitForBatch(client, batchId, args.pollSec);
    const got = await collectResults(client, batchId);
    specs = got.specs;
    usage = got.usage;
    rejected.push(...got.failed);
    defs = [...specs.keys()].map(id => CATALOG.find(d => d.id === id)).filter((d): d is DatasetDef => !!d);
    for (const id of specs.keys()) if (!defs.some(d => d.id === id)) rejected.push({ id, stage: "claude", reason: "custom_id is not in the catalog" });
    provenance = () => `batch ${batchId} (${MODEL}, effort ${EFFORT}) wrote title/legend/bins only.`;
  } else {
    mode = args.dryRun ? "dry-run" : "batch";
    defs = [];
    for (const def of CATALOG) {
      const used = alreadyUsed(def, ctx);
      if (used) rejected.push({ id: def.id, stage: "precheck", reason: used });
      else defs.push(def);
    }
    provenance = () => `batch (${MODEL}, effort ${EFFORT}) wrote title/legend/bins only.`;
  }

  console.log(`[maps] loading ${defs.length} dataset(s) from World Bank / REST Countries…`);
  const { loaded, failed } = await loadAll(defs, ctx);
  rejected.push(...failed);
  console.log(`[maps] ${loaded.length} passed the data precheck (>= ${MIN_COUNTRIES} countries, values from ${MIN_YEAR} on); ${failed.length} did not`);
  for (const f of failed) console.log(`  - ${f.id}: ${f.reason}`);

  let toBuild = loaded;
  if (mode === "dry-run" || (mode === "batch" && !batchId)) {
    const send = loaded.slice(0, args.count);
    if (!send.length) throw new Error("no dataset passed the precheck — nothing to send");
    const system = await fs.readFile(PROMPT_PATH, "utf-8");
    const requests = send.map(ds => buildRequest(ds, system));
    const inputTokensRough = Math.round(requests.reduce((s, r) => s + JSON.stringify(r.params).length, 0) / 4);
    const upperUsd = (inputTokensRough * BATCH_USD_PER_MTOK.input + requests.length * MAX_TOKENS * BATCH_USD_PER_MTOK.output) / 1e6;
    console.log(`[maps] ${requests.length} batch request(s); rough input ≈ ${inputTokensRough} tokens; cost upper bound (every request at max_tokens) ≈ $${upperUsd.toFixed(2)}`);
    await fs.mkdir(WORK_DIR, { recursive: true });

    if (mode === "dry-run") {
      const file = path.join(WORK_DIR, "batch-requests-dry-run.jsonl");
      await fs.writeFile(file, requests.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
      const p = requests[0]?.params;
      if (p) {
        console.log(`\n[maps] shared params: ${JSON.stringify({ model: p.model, max_tokens: p.max_tokens, thinking: p.thinking, output_config: { effort: EFFORT, format: "json_schema (SPEC_SCHEMA)" } })}`);
        console.log(`[maps] system = prompts/maps/spec.md (${system.length} chars)\n`);
      }
      for (const r of requests) {
        const content = r.params.messages[0].content;
        console.log(`--- custom_id: ${r.custom_id}\n${typeof content === "string" ? content : JSON.stringify(content)}\n`);
      }
      console.log(`[maps] full request bodies → ${path.relative(ROOT, file)}`);
      toBuild = send.slice(0, DRY_RUN_BUILD);
      for (const ds of toBuild) specs.set(ds.id, mechanicalSpec(ds));
      provenance = () => "DRY RUN: mechanical quintile spec, no Claude call. Do not promote.";
    } else {
      const client = new Anthropic();
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        console.warn("[maps] ANTHROPIC_API_KEY is not set (.env or env) — the SDK will try an `ant auth login` profile");
      }
      const batch = await client.messages.batches.create({ requests });
      batchId = batch.id;
      const stateFile = path.join(WORK_DIR, `batch-${batch.id}.json`);
      await fs.writeFile(stateFile, JSON.stringify({ batchId: batch.id, createdAt: batch.created_at, model: MODEL, datasets: send.map(d => d.id) }, null, 2) + "\n", "utf-8");
      console.log(`[maps] created ${batch.id} (state → ${path.relative(ROOT, stateFile)}). If this stops, resume with: npx tsx scripts/build-map-library.ts --batch-id ${batch.id}`);
      await waitForBatch(client, batch.id, args.pollSec);
      const got = await collectResults(client, batch.id);
      specs = got.specs;
      usage = got.usage;
      rejected.push(...got.failed);
      toBuild = send;
      const pv = `batch ${batch.id} (${MODEL}, effort ${EFFORT}) wrote title/legend/bins only.`;
      provenance = () => pv;
    }
  }

  const maps: MapEntry[] = [];
  const review: Review[] = [];
  for (const ds of toBuild) {
    const spec = specs.get(ds.id);
    if (!spec) continue;
    const r = buildCandidate(ds, spec, ctx, provenance(spec));
    if ("entry" in r) { maps.push(r.entry); review.push(r.review); }
    else rejected.push(r);
  }

  if (usage) {
    console.log(`[maps] usage: ${usage.requests} succeeded request(s), input ${usage.input} tokens, output ${usage.output} tokens (incl. thinking) → ≈ $${costUsd(usage).toFixed(3)} at batch prices ($${BATCH_USD_PER_MTOK.input}/$${BATCH_USD_PER_MTOK.output} per MTok)`);
  }

  const out = args.out ? path.resolve(args.out) : mode === "dry-run" ? path.join(WORK_DIR, "candidates-dry-run.json") : path.join(MAPS_DIR, "candidates.json");
  const doc = {
    generatedAt: new Date().toISOString(),
    generator: "scripts/build-map-library.ts",
    mode,
    ...(batchId ? { batchId, model: MODEL, effort: EFFORT } : {}),
    ...(usage ? { usage: { ...usage, estimatedUsd: Number(costUsd(usage).toFixed(4)) } } : {}),
    checks: { minCountries: MIN_COUNTRIES, minPerBin: MIN_PER_BIN, minYear: MIN_YEAR },
    maps,
    review,
    rejected,
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, formatMapsJson(doc), "utf-8");
  if (mode !== "dry-run") {
    // 上書きで消えないよう控えを output/ (gitignore) に残す
    await fs.mkdir(WORK_DIR, { recursive: true });
    await fs.writeFile(path.join(WORK_DIR, `${ctx.date}-${batchId ?? mode}-candidates.json`), formatMapsJson(doc), "utf-8");
  }
  const shown = path.relative(process.cwd(), out);
  console.log(`[maps] ${maps.length} candidate(s), ${rejected.length} rejected → ${shown.startsWith("..") ? out : shown}`);
  for (const m of maps) console.log(`  + ${m.id}: ${m.title} — ${m.legend.map(l => l.label).join(" | ")}`);
  for (const r of rejected.filter(r => r.stage !== "precheck" || !r.reason.includes("already"))) console.log(`  - ${r.id} [${r.stage}]: ${r.reason}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
