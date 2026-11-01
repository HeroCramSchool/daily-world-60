import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { geocode, distanceFromCountry } from "./geocode.js";

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

test("geocode: 壊れたキャッシュは空から始める", async () => {
  const file = await tmp();
  await fs.writeFile(file, "{not json");
  const g = await geocode("Kharkiv", "UA", { cacheFile: file, fetchImpl: fakeFetch(kharkiv) });
  assert.equal(g?.source, "wikipedia");
});
