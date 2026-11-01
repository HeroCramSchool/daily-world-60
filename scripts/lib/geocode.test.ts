import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { geoContains } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import { geocode, distanceFromCountry } from "./geocode.js";
import { countryLonLat } from "./worldmap.js";

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(pages: unknown, calls: Call[] = [], status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ batchcomplete: true, query: { pages } }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const kharkiv = [{ pageid: 1, ns: 0, title: "Kharkiv", coordinates: [{ lat: 49.9925, lon: 36.231389, primary: true, globe: "earth" }] }];
const tmp = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), "geocode-")), "geocode-cache.json");

test("geocode: Routine の mapMarkers の名前が同じならその座標（大文字小文字は問わない）", async () => {
  const calls: Call[] = [];
  const g = await geocode("  kharkiv ", "UA", { markers: [{ lon: 36.2, lat: 50, label: "Kharkiv" }], fetchImpl: fakeFetch(kharkiv, calls) });
  assert.deepEqual(g, { lon: 36.2, lat: 50, source: "marker" });
  assert.equal(calls.length, 0);
});

test("geocode: Wikipedia の座標を使い、User-Agent にメールを入れない", async () => {
  const calls: Call[] = [];
  const g = await geocode("Kharkiv", "UA", { markers: [{ lon: 30.7, lat: 46.5, label: "Odesa" }], fetchImpl: fakeFetch(kharkiv, calls) });
  assert.deepEqual(g, { lon: 36.231389, lat: 49.9925, source: "wikipedia" });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://en.wikipedia.org/w/api.php");
  assert.equal(u.searchParams.get("titles"), "Kharkiv");
  assert.equal(u.searchParams.get("prop"), "coordinates");
  assert.equal(u.searchParams.get("redirects"), "1");
  assert.equal(u.searchParams.get("formatversion"), "2");
  assert.match(calls[0].headers["User-Agent"], /^DailyWorld60\/1\.0 \(https:\/\//);
  assert.doesNotMatch(calls[0].headers["User-Agent"], /@/);
});

test("geocode: 座標の無い記事・無い記事は null", async () => {
  assert.equal(await geocode("Nowhereville", "UA", { fetchImpl: fakeFetch([{ ns: 0, title: "Nowhereville", missing: true }]) }), null);
  assert.equal(await geocode("Mercury", "UA", { fetchImpl: fakeFetch([{ ns: 0, title: "Mercury", coordinates: [{ lat: 1, lon: 2, globe: "mercury" }] }]) }), null);
  assert.equal(await geocode("", "UA", { fetchImpl: fakeFetch(kharkiv) }), null);
});

test("geocode: 国の中心から 2500 km より遠い答えは捨てる（中心が分からない国は捨てない）", async () => {
  const paris = [{ ns: 0, title: "Paris, Texas", coordinates: [{ lat: 33.66, lon: -95.55, globe: "earth" }] }];
  assert.equal(await geocode("Paris", "FR", { fetchImpl: fakeFetch(paris) }), null);
  assert.deepEqual(await geocode("Paris", "XX", { fetchImpl: fakeFetch(paris) }), { lon: -95.55, lat: 33.66, source: "wikipedia" });
});

test("geocode: 広い国は端の都市を捨てない（RU の中心はシベリア）", async () => {
  const moscow = [{ ns: 0, title: "Moscow", coordinates: [{ lat: 55.7558, lon: 37.6173, globe: "earth" }] }];
  assert.ok(distanceFromCountry({ lon: 37.6173, lat: 55.7558 }, "RU")! > 2500);
  assert.deepEqual(await geocode("Moscow", "RU", { fetchImpl: fakeFetch(moscow) }), { lon: 37.6173, lat: 55.7558, source: "wikipedia" });
  assert.equal((await geocode("Moscow", "UA", { fetchImpl: fakeFetch(moscow) }))?.source, "wikipedia");
});

test("geocode: ネットの失敗・HTTP の誤り・時間切れで例外を出さず null", async () => {
  const boom = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.equal(await geocode("Kharkiv", "UA", { fetchImpl: boom }), null);
  assert.equal(await geocode("Kharkiv", "UA", { fetchImpl: fakeFetch(kharkiv, [], 503) }), null);
  const notJson = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  assert.equal(await geocode("Kharkiv", "UA", { fetchImpl: notJson }), null);
  const hang = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  const t0 = Date.now();
  assert.equal(await geocode("Kharkiv", "UA", { fetchImpl: hang, timeoutMs: 50 }), null);
  assert.ok(Date.now() - t0 < 2000);
});

test("geocode: 結果をファイルに残し、2回目は聞かない。聞けなかったときは残さない", async () => {
  const file = await tmp();
  const calls: Call[] = [];
  await geocode("Kharkiv", "UA", { cacheFile: file, fetchImpl: fakeFetch(kharkiv, calls) });
  await geocode("kharkiv", "UA", { cacheFile: file, fetchImpl: fakeFetch(kharkiv, calls) });
  assert.equal(calls.length, 1);
  await geocode("Atlantis", "UA", { cacheFile: file, fetchImpl: fakeFetch([{ ns: 0, title: "Atlantis", missing: true }], calls) });
  assert.equal(await geocode("Atlantis", "UA", { cacheFile: file, fetchImpl: fakeFetch(kharkiv, calls) }), null);
  assert.equal(calls.length, 2);
  const boom = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await geocode("Odesa", "UA", { cacheFile: file, fetchImpl: boom });
  const saved = JSON.parse(await fs.readFile(file, "utf-8"));
  assert.deepEqual(saved, { "UA|kharkiv": { lon: 36.231389, lat: 49.9925 }, "UA|atlantis": null });
});

/** titles ごとに pages を返す偽の Wikipedia。載っていない題名は記事なし。 */
function byTitle(table: Record<string, unknown[] | Error>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const title = new URL(String(input)).searchParams.get("titles") ?? "";
    calls.push(title);
    const hit = table[title];
    if (hit instanceof Error) throw hit;
    const pages = hit ?? [{ ns: 0, title, missing: true }];
    return new Response(JSON.stringify({ batchcomplete: true, query: { pages } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const at = (title: string, lat: number, lon: number) => [{ ns: 0, title, coordinates: [{ lat, lon, primary: true, globe: "earth" }] }];
const HYDERABAD = {
  "Hyderabad": at("Hyderabad", 17.36, 78.47),
  "Hyderabad, Pakistan": at("Hyderabad, Sindh", 25.38, 68.37),
};

test("geocode: 国名があれば先に「地名, 国名」を引く（隣の国の同名の都市を拾わない: PK の Hyderabad）", async () => {
  // 国名なしでは今までどおり主記事 (インドのハイデラバード) が国の中心から 2500 km 以内で通ってしまう
  assert.deepEqual(await geocode("Hyderabad", "PK", { fetchImpl: byTitle(HYDERABAD) }), { lon: 78.47, lat: 17.36, source: "wikipedia" });
  const calls: string[] = [];
  assert.deepEqual(await geocode("Hyderabad", "PK", { countryName: "Pakistan", fetchImpl: byTitle(HYDERABAD, calls) }), { lon: 68.37, lat: 25.38, source: "wikipedia" });
  assert.deepEqual(calls, ["Hyderabad, Pakistan"]);
});

test("geocode: 「地名, 国名」の記事が無ければ地名だけで引く（UA の本の Kursk は国外でも通す）", async () => {
  const calls: string[] = [];
  const g = await geocode("Kursk", "UA", { countryName: "Ukraine", fetchImpl: byTitle({ "Kursk": at("Kursk", 51.73, 36.19) }, calls) });
  assert.deepEqual(g, { lon: 36.19, lat: 51.73, source: "wikipedia" });
  assert.deepEqual(calls, ["Kursk, Ukraine", "Kursk"]);
});

test("geocode: 「地名, 国名」の答えも国から遠すぎれば捨て、地名だけで引き直す", async () => {
  const calls: string[] = [];
  const g = await geocode("Rafah", "PS", { countryName: "Palestine", fetchImpl: byTitle({ "Rafah, Palestine": at("Somewhere", -33.9, 18.4), "Rafah": at("Rafah", 31.29, 34.25) }, calls) });
  assert.deepEqual(g, { lon: 34.25, lat: 31.29, source: "wikipedia" });
  assert.deepEqual(calls, ["Rafah, Palestine", "Rafah"]);
});

test("geocode: 国名そのもの・国名を含む地名は修飾しない", async () => {
  const calls: string[] = [];
  const f = byTitle({ "pakistan": at("Pakistan", 30, 70), "Hyderabad, Pakistan": HYDERABAD["Hyderabad, Pakistan"] }, calls);
  assert.equal((await geocode("pakistan", "PK", { countryName: "Pakistan", fetchImpl: f }))?.lon, 70);
  assert.equal((await geocode("Hyderabad, Pakistan", "PK", { countryName: "Pakistan", fetchImpl: f }))?.lon, 68.37);
  assert.deepEqual(calls, ["pakistan", "Hyderabad, Pakistan"]);
});

test("geocode: 「地名, 国名」を聞けなかったときは地名だけの答えで済ませず、残しもしない", async () => {
  const file = await tmp();
  const calls: string[] = [];
  const f = byTitle({ ...HYDERABAD, "Hyderabad, Pakistan": new TypeError("fetch failed") }, calls);
  assert.equal(await geocode("Hyderabad", "PK", { countryName: "Pakistan", cacheFile: file, fetchImpl: f }), null);
  assert.deepEqual(calls, ["Hyderabad, Pakistan"]);
  await assert.rejects(fs.readFile(file, "utf-8"));
  assert.equal((await geocode("Hyderabad", "PK", { countryName: "Pakistan", cacheFile: file, fetchImpl: byTitle(HYDERABAD) }))?.lon, 68.37);
});

test("geocode: 壊れたキャッシュは空から始める", async () => {
  const file = await tmp();
  await fs.writeFile(file, "{not json");
  const g = await geocode("Kharkiv", "UA", { cacheFile: file, fetchImpl: fakeFetch(kharkiv) });
  assert.equal(g?.source, "wikipedia");
});

test("国の中心: 解説形式の地図の国 (Natural Earth) はほぼ全部が持ち、中心は国の陸の中。GL は持たない", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const topo = JSON.parse(readFileSync(path.resolve(here, "..", "..", "assets", "realmap", "countries.json"), "utf-8")) as Topology;
  const countries = (feature(topo, topo.objects.countries as GeometryCollection) as FeatureCollection<Geometry, { ISO_A2_EH?: string; ADM0_A3?: string }>).features;
  // GL は Routine が「世界全体」の意味でも使う。AQ は極、KI・UM・TF は島が広く散らばる
  const skip = new Set(["-99", "GL", "AQ", "KI", "UM", "TF"]);
  const missing = [...new Set(countries.map(f => f.properties.ISO_A2_EH ?? "-99").filter(c => !skip.has(c) && !countryLonLat(c)))];
  assert.deepEqual(missing, []);
  assert.equal(countryLonLat("GL"), null);
  for (const [cc, a3] of [["GE", "GEO"], ["AF", "AFG"], ["KZ", "KAZ"], ["TW", "TWN"], ["AM", "ARM"], ["AZ", "AZE"], ["BY", "BLR"], ["CU", "CUB"], ["HT", "HTI"], ["LK", "LKA"], ["XK", "KOS"], ["PT", "PRT"]]) {
    const f = countries.find(x => x.properties.ADM0_A3 === a3)!;
    assert.ok(geoContains(f, countryLonLat(cc)!), `${cc} ${countryLonLat(cc)}`);
  }
});

test("geocode: 中心を足した国では、隣の大陸の同名の土地を捨てる（GE の Georgia 州）", async () => {
  const georgiaUS = at("Georgia (U.S. state)", 32.9, -83.4);
  assert.equal(await geocode("Georgia", "GE", { fetchImpl: byTitle({ "Georgia": georgiaUS }) }), null);
});
