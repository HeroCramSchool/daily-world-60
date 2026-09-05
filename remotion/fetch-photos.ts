import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

/**
 * ショート用の実写を Wikimedia Commons からまとめて取る。
 *
 * 既存の fetch-broll.ts は 1 ストーリー 6 枚しか取らないため、47 秒の動画で
 * 同じ絵が 9 秒ずつ映る。ここでは script-en.json の imageQueries (6本) それぞれから
 * 複数枚拾い、チャンクごとに別の写真を当てられる枚数 (~20枚) を確保する。
 *
 * 出力: remotion/public/short/photo-{code}-{nn}.jpg + CREDITS-{code}.md
 */

const W = 1080;
const H = 1920;
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "DailyWorld60/1.0 (https://github.com/HeroCramSchool/daily-world-60)";
const PER_QUERY = Number(process.env.PHOTOS_PER_QUERY ?? "4");
const TARGET = Number(process.env.PHOTOS_TARGET ?? "20");

const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

interface Img { title: string; url: string; descUrl: string; license: string; artist: string; rank: number }

// Commons のカテゴリで実写と図版を分ける。タイトル語だけでは
// "Space Launch System configurations" のような図表を弾けなかった (2026-08-30 実測)。
const CAT_GRAPHIC = /diagram|infographic|schematic|trajectory|\bcharts?\b/i;
const CAT_PHOTO = /photograph|photos?\b|pictures|images by|taken on|taken in/i;

const BAD_TITLE = [
  /\b(flag|logo|icon|coat of arms|seal|emblem|locator)\b/i,
  /\b(map|chart|diagram|graph|infographic|statistics|decree|document)\b/i,
  /\b(results?|runoff|exit poll|tally|topographic)\b/i,
  /opentopomap|openstreetmap|topo\s?map/i,
];

async function searchCommons(query: string): Promise<Img[]> {
  const params = new URLSearchParams({
    action: "query", format: "json", generator: "search",
    gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "20",
    prop: "imageinfo|categories", iiprop: "url|extmetadata|mime|size", iiurlwidth: "1600",
    cllimit: "max",
  });
  const res = await fetch(`${COMMONS_API}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  const json = await res.json() as {
    query?: { pages?: Record<string, {
      title: string; index?: number;
      categories?: Array<{ title: string }>;
      imageinfo?: Array<{ thumburl?: string; url?: string; descriptionurl?: string; mime?: string; width?: number;
                          extmetadata?: Record<string, { value?: string }> }>;
    }> };
  };
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  const out: Img[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii?.mime || !/image\/jpeg/.test(ii.mime)) continue;
    if ((ii.width ?? 0) < 900) continue;
    const title = p.title.replace(/^File:/, "");
    if (BAD_TITLE.some(re => re.test(title))) continue;
    const cats = (p.categories ?? []).map(c => c.title.replace(/^Category:/, ""));
    if (cats.some(c => CAT_GRAPHIC.test(c))) continue;
    const looksPhoto = cats.some(c => CAT_PHOTO.test(c));
    const md = ii.extmetadata ?? {};
    out.push({
      title,
      url: ii.thumburl ?? ii.url ?? "",
      descUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      license: md.LicenseShortName?.value ?? "",
      artist: stripHtml(md.Artist?.value ?? ""),
      // 実写カテゴリを持つものを優先し、判別材料が無いものは後ろへ回す
      rank: (p.index ?? 999) + (looksPhoto ? 0 : 3),
    });
  }
  return out.filter(i => i.url).sort((a, b) => a.rank - b.rank);
}

/** 写真を切らずに 1080x1920 へ。自身のブラー版を背景に敷いて余白を埋める (fetch-broll と同じ方針)。 */
async function toFrame(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const bg = await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).blur(48).modulate({ brightness: 0.6 }).toBuffer();
  const fg = await sharp(buf).resize(W, H, { fit: "inside", withoutEnlargement: false }).toBuffer();
  await sharp(bg).composite([{ input: fg, gravity: "centre" }]).jpeg({ quality: 86 }).toFile(dest);
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();

const STOP = new Set(["the","a","an","and","or","but","for","with","from","that","this","after","before",
  "more","than","into","over","under","about","their","there","been","have","has","will","would","could",
  "says","said","new","first","last","year","years","month","week","day","days","people","world"]);
// 曜日/月/方角など、単独では検索価値の無い大文字語
const WEAK_CAP = new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "january","february","march","april","may","june","july","august","september","october","november","december",
  "north","south","east","west","new","the","a","an"]);

/**
 * imageQueries が無い回のフォールバック。見出し+要約から固有名詞を拾って検索語を作る。
 * fetch-broll.ts の buildQueries と同じ考え方 (具体的 → 一般的の順)。
 * 見出し1文をそのまま投げると Commons はほぼ 0 件になる (2026-09-05 実測)。
 */
function fallbackQueries(countryName: string, headline: string, summary: string): string[] {
  const text = `${headline}. ${summary}`;
  const connectors = new Set(["of", "the", "de", "al", "el", "da"]);
  const entities: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) entities.push(cur.join(" ")); cur = []; };
  for (const tok of text.split(/\s+/)) {
    const w = tok.replace(/[^\p{L}\p{N}'-]/gu, "");
    const endsClause = /[.,;:!?)]$/.test(tok);
    if (w && /^\p{Lu}/u.test(w)) cur.push(w);
    else if (w && connectors.has(w.toLowerCase()) && cur.length) cur.push(w.toLowerCase());
    else flush();
    if (endsClause) flush();
  }
  flush();

  const ents = [...new Set(entities.map(e =>
      e.replace(/^(the|a|an)\s+/i, "").replace(/\s+(of|the|and|for)$/i, "").trim()))]
    .filter(e => e.length > 2)
    .filter(e => /\s/.test(e) || !WEAK_CAP.has(e.toLowerCase()))
    .sort((a, b) => (b.split(" ").length - a.split(" ").length) || (b.length - a.length));

  const content = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 4 && !STOP.has(w));
  const topWords = [...new Set(content)].slice(0, 4);

  // 単語1語の固有名詞 ("Children" "Officials" "They") は文頭の大文字を拾っただけのことが多く、
  // 単独で投げると無関係な写真を引く (2026-09-05 実測: 20枚中6枚が別の国)。
  // 複数語のものだけ単独クエリにし、1語のものは国名と組み合わせる。
  const multi = ents.filter(e => /\s/.test(e));
  const single = ents.filter(e => !/\s/.test(e));

  const q: string[] = [];
  for (const e of multi.slice(0, 3)) q.push(e);
  for (const e of multi.slice(0, 2)) q.push(`${countryName} ${e}`);
  for (const e of single.slice(0, 2)) q.push(`${countryName} ${e}`);
  for (const w of topWords) q.push(`${countryName} ${w}`);
  if (countryName) q.push(countryName);
  return [...new Set(q)].filter(q2 => q2.trim()).slice(0, 8);
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join(ROOT, "output", date);
  const pub = path.join(HERE, "public", "short");
  await fs.mkdir(pub, { recursive: true });

  const script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8")) as {
    stories: Array<{ index: number; country: { code: string; name?: string }; headline: string; summary?: string; imageQueries?: string[] }>;
  };

  for (const story of script.stories) {
    const code = story.country.code.toLowerCase();
    const queries = (story.imageQueries?.length
      ? story.imageQueries
      : fallbackQueries(story.country.name ?? "", story.headline, story.summary ?? "")).slice(0, 8);
    console.log(`[photos] ${code}: queries = ${queries.join(" / ")}`);

    const seen = new Set<string>();
    const picked: Img[] = [];
    // クエリを一巡ずつ回して拾う = 特定クエリの写真だけに偏らない
    for (let round = 0; round < PER_QUERY && picked.length < TARGET; round++) {
      for (const q of queries) {
        if (picked.length >= TARGET) break;
        const hits = await searchCommons(q).catch(e => {
          console.warn(`[photos] ${code}: "${q}" search failed (${e instanceof Error ? e.message : e})`);
          return [] as Img[];
        });
        const hit = hits.filter(h => !seen.has(h.title))[round] ?? hits.find(h => !seen.has(h.title));
        if (!hit) continue;
        seen.add(hit.title);
        picked.push(hit);
      }
    }

    const credits: string[] = [`# Photo credits — ${story.country.name ?? code} (${date})`, ""];
    let n = 0;
    for (const img of picked) {
      const name = `photo-${code}-${String(n + 1).padStart(2, "0")}.jpg`;
      try {
        await toFrame(img.url, path.join(pub, name));
      } catch (e) {
        console.warn(`[photos] ${code}: ${img.title} failed (${e instanceof Error ? e.message : e})`);
        continue;
      }
      credits.push(`- ${name} — ${img.title} (${img.license || "see Commons"})${img.artist ? ` by ${img.artist}` : ""}`);
      credits.push(`  ${img.descUrl}`);
      n++;
    }
    await fs.writeFile(path.join(pub, `CREDITS-${code}.md`), credits.join("\n"), "utf-8");
    console.log(`[photos] ${code}: ${n} photos from ${queries.length} queries`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
