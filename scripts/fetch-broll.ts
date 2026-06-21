import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

/**
 * 各ストーリーの背景画像を Wikimedia Commons から取得して
 * output/YYYY-MM-DD/_assets/ に保存する。build-news-video.ts の前に必ず実行する。
 *
 * 出力 (各 story / code 例: lb, co, rw):
 *   _assets/bg-{code}-1..6.jpg   (1080x1920, ニュース関連, CC/PD)
 *   _assets/{code}.png           (国旗, flagcdn 由来 = Wikimedia-derived PD)
 *   _assets/CREDITS.md           (出典・ライセンス一覧)
 *
 * 入力:  output/YYYY-MM-DD/script-en.json
 *
 * 設計方針:
 *   - 国名 + 見出しの固有名詞/トピック語で Commons を検索し、記事に関連する写真を選ぶ
 *   - bg-1..6 は「必ず」存在させる (取得数が足りなければ cycle、ゼロなら単色フォールバック)
 *   - 国営プロパガンダ系ソースは Commons 検索では問題にならないが、flag/logo/地図アイコンは除外
 */

const W = 1080;
const H = 1920;
const BG_COUNT = 6;

interface Story {
  index: number;
  country: { code: string; flag: string; name?: string };
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  imageQueries?: string[];
}
interface ScriptJson { date: string; stories: Story[] }

interface CommonsImage {
  title: string;
  thumbUrl: string;
  descUrl: string;
  license: string;
  artist: string;
}

// ISO 3166-1 alpha-2 → 英語国名 (世界ニュースで頻出する国を網羅)。未知コードは code をそのまま使う。
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", FR: "France", DE: "Germany", IT: "Italy",
  ES: "Spain", PT: "Portugal", NL: "Netherlands", BE: "Belgium", CH: "Switzerland",
  AT: "Austria", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", IE: "Ireland",
  PL: "Poland", UA: "Ukraine", RU: "Russia", BY: "Belarus", CZ: "Czech Republic",
  GR: "Greece", TR: "Turkey", RO: "Romania", HU: "Hungary",
  CN: "China", JP: "Japan", KR: "South Korea", KP: "North Korea", IN: "India",
  PK: "Pakistan", BD: "Bangladesh", ID: "Indonesia", MY: "Malaysia", SG: "Singapore",
  TH: "Thailand", VN: "Vietnam", PH: "Philippines", TW: "Taiwan",
  IL: "Israel", LB: "Lebanon", SY: "Syria", IQ: "Iraq", IR: "Iran", SA: "Saudi Arabia",
  AE: "United Arab Emirates", QA: "Qatar", KW: "Kuwait", YE: "Yemen", JO: "Jordan",
  EG: "Egypt", LY: "Libya", TN: "Tunisia", DZ: "Algeria", MA: "Morocco", SD: "Sudan",
  ET: "Ethiopia", KE: "Kenya", NG: "Nigeria", GH: "Ghana", ZA: "South Africa",
  CD: "Democratic Republic of the Congo", RW: "Rwanda", UG: "Uganda", TZ: "Tanzania",
  SO: "Somalia", ML: "Mali", SN: "Senegal", CM: "Cameroon",
  CA: "Canada", MX: "Mexico", BR: "Brazil", AR: "Argentina", CL: "Chile",
  CO: "Colombia", PE: "Peru", VE: "Venezuela", EC: "Ecuador", BO: "Bolivia",
  AU: "Australia", NZ: "New Zealand",
};

// 見出しに含まれていたら背景クエリのトピック語として優先するテーマ。
const TOPIC_TERMS = [
  "election", "vote", "president", "parliament", "protest", "war", "conflict",
  "military", "army", "missile", "nuclear", "energy", "earthquake", "flood",
  "storm", "wildfire", "drought", "summit", "treaty", "deal", "economy",
  "inflation", "court", "trial", "border", "refugee", "health", "outbreak",
  "virus", "vaccine", "climate", "oil", "gas", "trade", "ceasefire", "peace",
];

const STOPWORDS = new Set([
  "the", "a", "an", "as", "of", "in", "on", "to", "for", "and", "or", "with",
  "into", "over", "after", "before", "amid", "says", "say", "new", "deal",
  "today", "year", "years", "day", "days", "week", "month",
]);

// 文頭で大文字になるだけの一般語 (固有名詞ではない)。単語エンティティから除外する。
const COMMON_CAP_FALSE = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "analysts", "officials", "experts", "critics", "leaders", "authorities",
  "leftist", "rightist", "many", "some", "several", "other", "others", "both",
  "this", "that", "these", "those", "however", "meanwhile", "according",
  "after", "before", "during", "following", "two", "three", "four", "five",
  "north", "south", "east", "west", "northern", "southern", "eastern", "western",
  "president", "government", "people", "police", "military", "army",
]);

// 背景に不向きな「一般的すぎる被写体」: 野生動物・植物・収集物・標本など。フォールバック時に下位へ。
const OFFTOPIC_RE = /\b(bird|toucan|parrot|owl|eagle|insect|ant|beetle|butterfly|moth|bee|wasp|spider|amber|flower|orchid|fungus|mushroom|frog|lizard|snake|fish|wildlife|fauna|flora|botanical|specimen|stamp|banknote|coin|postage|moth|larva|caterpillar|shell|fossil|mineral)\b/i;

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "DailyWorld60/1.0 (news shorts pipeline; contact info@hero-english.net)";

// Pexels (実写ストック) — ニュース題材はキーワード適合が Commons より高く、被写体が内容を想起させやすい。
// 一次ソースに使い、空/失敗時のみ Commons にフォールバック (searchImages)。
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const PEXELS_API = "https://api.pexels.com/v1/search";

async function searchPexels(query: string): Promise<CommonsImage[]> {
  if (!PEXELS_KEY) return [];
  const url = `${PEXELS_API}?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY, "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`pexels HTTP ${res.status}`);
  const json = await res.json() as {
    photos?: Array<{ id: number; photographer?: string; photographer_url?: string; alt?: string;
      src?: { portrait?: string; large2x?: string; large?: string } }>;
  };
  return (json.photos ?? [])
    .map(p => ({
      title: (p.alt && p.alt.trim()) || `Pexels photo ${p.id}`,
      thumbUrl: p.src?.portrait || p.src?.large2x || p.src?.large || "",
      descUrl: p.photographer_url || "https://www.pexels.com",
      license: "Pexels License (free to use)",
      artist: p.photographer || "",
    }))
    .filter(im => im.thumbUrl && !OFFTOPIC_RE.test(im.title));
}

// 画像検索の入口: Pexels 優先 (関連性が高い)、結果ゼロ or エラー時は Wikimedia Commons へフォールバック。
async function searchImages(query: string): Promise<CommonsImage[]> {
  if (PEXELS_KEY) {
    try {
      const px = await searchPexels(query);
      if (px.length) return px;
    } catch (e) {
      console.warn(`[broll] pexels failed for "${query}": ${e instanceof Error ? e.message : e}`);
    }
  }
  return searchCommons(query);
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const assets = path.join(dir, "_assets");
  await fs.mkdir(assets, { recursive: true });

  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  const creditLines: string[] = [
    "# Image Credits (auto-fetched: Pexels primary, Wikimedia Commons fallback)",
    "",
    `Generated by scripts/fetch-broll.ts for ${date}.`,
    "Background images sourced from Pexels (Pexels License, free to use) with Wikimedia Commons (CC-BY / CC-BY-SA / PD) as fallback.",
    "Flag PNGs from flagcdn.com (Wikimedia-derived, PD).",
    "",
  ];

  for (const story of script.stories) {
    const code = story.country.code.toLowerCase();
    const countryName = story.country.name ?? COUNTRY_NAMES[story.country.code.toUpperCase()] ?? story.country.code;

    const queries = (Array.isArray(story.imageQueries) && story.imageQueries.length)
      ? [...story.imageQueries, countryName]
      : buildQueries(countryName, story.headline, story.summary);
    console.log(`[broll] ${code} (${countryName}) queries: ${queries.join(" | ")}`);

    const results: CommonsImage[][] = [];
    for (const q of queries) {
      results.push(await searchImages(q).catch(e => {
        console.warn(`[broll] search failed for "${q}": ${e instanceof Error ? e.message : e}`);
        return [] as CommonsImage[];
      }));
    }
    // 1巡目は各クエリ最大3枚で被写体を散らし、足りなければ2巡目で上限なく補充する。
    const picked: CommonsImage[] = [];
    const seen = new Set<string>();
    for (const cap of [3, BG_COUNT]) {
      for (const imgs of results) {
        let perQ = 0;
        for (const img of imgs) {
          if (picked.length >= BG_COUNT || perQ >= cap) break;
          if (seen.has(img.title)) continue;
          seen.add(img.title);
          picked.push(img);
          perQ++;
        }
        if (picked.length >= BG_COUNT) break;
      }
      if (picked.length >= BG_COUNT) break;
    }

    creditLines.push(`## Story ${story.index} — ${countryName}: ${story.headline}`);

    // 取得画像を 1080x1920 にクロップして bg-{code}-N.jpg へ。
    const savedBg: number[] = [];
    for (let i = 0; i < picked.length && i < BG_COUNT; i++) {
      const img = picked[i];
      const dest = path.join(assets, `bg-${code}-${i + 1}.jpg`);
      try {
        await downloadAndCrop(img.thumbUrl, dest);
        savedBg.push(i + 1);
        creditLines.push(`- bg-${code}-${i + 1}.jpg — ${img.title} (${img.license || "see Commons"}) ${img.artist ? `by ${stripHtml(img.artist)}` : ""}\n  ${img.descUrl}`);
      } catch (e) {
        console.warn(`[broll] download/crop failed (${img.title}): ${e instanceof Error ? e.message : e}`);
      }
    }

    // 1 枚も取れなかった場合: 国名のみで広く再検索 → それでもダメなら単色フォールバック。
    if (savedBg.length === 0) {
      const fallbackImgs = await searchImages(countryName).catch(() => [] as CommonsImage[]);
      for (let i = 0; i < fallbackImgs.length && savedBg.length < BG_COUNT; i++) {
        const dest = path.join(assets, `bg-${code}-${savedBg.length + 1}.jpg`);
        try {
          await downloadAndCrop(fallbackImgs[i].thumbUrl, dest);
          savedBg.push(savedBg.length + 1);
          creditLines.push(`- bg-${code}-${savedBg.length}.jpg — ${fallbackImgs[i].title} (fallback)\n  ${fallbackImgs[i].descUrl}`);
        } catch { /* keep trying */ }
      }
    }
    if (savedBg.length === 0) {
      await solidFallback(path.join(assets, `bg-${code}-1.jpg`), countryName);
      savedBg.push(1);
      creditLines.push(`- bg-${code}-1.jpg — solid-color fallback (no Commons image found)`);
      console.warn(`[broll] ${code}: no Commons image, used solid fallback`);
    }

    // bg-1..6 を必ず揃える: 不足分は取得済みを cycle してコピー。
    for (let n = 1; n <= BG_COUNT; n++) {
      const target = path.join(assets, `bg-${code}-${n}.jpg`);
      if (await exists(target)) continue;
      const src = path.join(assets, `bg-${code}-${savedBg[(n - 1) % savedBg.length]}.jpg`);
      await fs.copyFile(src, target).catch(() => {});
    }

    // 国旗 PNG
    await fetchFlag(story.country.code, path.join(assets, `${code}.png`)).catch(e => {
      console.warn(`[broll] flag fetch failed (${code}): ${e instanceof Error ? e.message : e}`);
    });

    creditLines.push("");
    console.log(`[broll] ${code}: ${savedBg.length} unique bg saved, bg-1..6 ensured`);
  }

  await fs.writeFile(path.join(assets, "CREDITS.md"), creditLines.join("\n"), "utf-8");
  console.log(`[broll] done → ${assets}`);
}

/** 見出し + 要約 + 国名から Commons 検索クエリを構築する (記事関連の写真を狙う)。
 *  見出しだけでなく要約も使い、複数語の固有名詞 (地名・人名・組織名) を優先する。
 *  並びは「具体的 → 一般的」: 固有名詞 > トピック > 内容語 > 国名のみ。 */
function buildQueries(countryName: string, headline: string, summary: string): string[] {
  const text = `${headline}. ${summary}`;

  // 連続する大文字始まりの語 (+ of/the/and 等の接続語) を1つの固有名詞として束ねる。
  // 例: "World Health Organization", "Strait of Hormuz", "Donald Trump"
  // "of/the/de/..." は1つの固有名詞内の連結語 (Strait of Hormuz, Bank of America)。
  // "and" は別々の固有名詞を繋いでしまう (US and Iran) ので連結語に入れない。
  const connectors = new Set(["of", "the", "de", "al", "el", "da"]);
  const entities: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) entities.push(cur.join(" ")); cur = []; };
  for (const tok of text.split(/\s+/)) {
    const w = tok.replace(/[^\p{L}\p{N}'-]/gu, "");   // 記号除去 (アクセント付き文字は保持)
    const endsClause = /[.,;:!?)]$/.test(tok);         // 文/節の切れ目で固有名詞を分断
    if (w && /^\p{Lu}/u.test(w)) cur.push(w);
    else if (w && connectors.has(w.toLowerCase()) && cur.length) cur.push(w.toLowerCase());
    else flush();
    if (endsClause) flush();
  }
  flush();

  // 先頭の冠詞・末尾の接続語を落とし、国名/短すぎ/一般語を除外、重複除去。
  // 複数語の固有名詞 (人名・地名・組織名) を優先し、その中で具体的(=長い)順。
  const cleaned = [...new Set(entities.map(e =>
    e.replace(/^(the|a|an)\s+/i, "").replace(/\s+(of|the|and|for)$/i, "").trim()))]
    .filter(e => e.length > 2)
    .filter(e => e.toLowerCase() !== countryName.toLowerCase() && !countryName.toLowerCase().includes(e.toLowerCase()))
    .filter(e => /\s/.test(e) || !COMMON_CAP_FALSE.has(e.toLowerCase()))  // 単語は一般語(月/曜日/方角等)を除外
    .sort((a, b) => (b.split(" ").length - a.split(" ").length) || (b.length - a.length));

  const lower = text.toLowerCase();
  const topics = TOPIC_TERMS.filter(t => new RegExp(`\\b${t}\\b`).test(lower));
  const content = lower.replace(/[^\w\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w) && !TOPIC_TERMS.includes(w));

  const q: string[] = [];
  for (const e of cleaned.slice(0, 3)) {
    q.push(`${countryName} ${e}`);
    if (/\s/.test(e)) q.push(e); // 複数語の固有名詞は単体でも (地名/人名そのものを狙う)
  }
  if (topics[0]) q.push(`${countryName} ${topics[0]}`);
  if (content[0]) q.push(`${countryName} ${content[0]}`);
  q.push(countryName);
  return [...new Set(q.map(s => s.trim()).filter(Boolean))];
}

/** Wikimedia Commons 画像検索。記事背景に向く大きめの写真のみ返す。 */
async function searchCommons(query: string): Promise<CommonsImage[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "16",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: "1280",
  });
  const res = await fetch(`${COMMONS_API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  const json = await res.json() as {
    query?: { pages?: Record<string, {
      title: string;
      index?: number;
      imageinfo?: Array<{
        thumburl?: string; url?: string; descriptionurl?: string;
        mime?: string; width?: number; height?: number;
        extmetadata?: Record<string, { value?: string }>;
      }>;
    }> };
  };
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  const out: Array<CommonsImage & { rank: number }> = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    if (!ii.mime || !/image\/jpeg/.test(ii.mime)) continue; // 写真のみ採用。PNG(図表/地図/ロゴ/インフォグラフィック)は背景に不向きなので除外
    if ((ii.width ?? 0) < 800) continue;
    const title = p.title.replace(/^File:/, "");
    // 背景に不向きな素材を除外: 国旗/ロゴ/地図/紋章アイコン類 + チャート/図表/文書スキャン類
    if (/\b(flag|logo|icon|coat of arms|seal|emblem|locator)\b/i.test(title)) continue;
    if (/\b(map|chart|diagram|graph|infographic|statistics|expectancy|decree|document)\b/i.test(title)) continue;
    // 選挙結果/世論調査/地形図など「関連はするが背景写真に不向き」な図表類も除外。
    if (/\b(results?|encuestas?|runoff|exit poll|tally|topographic)\b/i.test(title)) continue;
    if (/opentopomap|openstreetmap|topo\s?map/i.test(title)) continue;
    if (/указ|диаграмм|карта/i.test(title)) continue; // ロシア語: 法令/図表/地図
    const md = ii.extmetadata ?? {};
    out.push({
      title,
      thumbUrl: ii.thumburl ?? ii.url ?? "",
      descUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      license: md.LicenseShortName?.value ?? "",
      artist: md.Artist?.value ?? "",
      // 検索結果の関連度ランク (小さいほど関連)。一般的すぎる被写体
      // (野生動物/植物/収集物) には大きなペナルティで下位へ。
      rank: (p.index ?? 999) + (OFFTOPIC_RE.test(title) ? 30 : 0),
    });
  }
  // Commons の検索関連度を尊重する。面積(解像度)順に並べ替えない — 関連性が壊れ一般風景が選ばれるため。
  out.sort((a, b) => a.rank - b.rank);
  return out.filter(i => i.thumbUrl).map(({ rank, ...rest }) => { void rank; return rest; });
}

/**
 * 画像を 1080x1920 に保存する。写真を切らずに**全体**を見せるため、
 * 自身のブラー版を背景に敷き、写真全体 (contain) を中央に重ねる。
 * → 縦長フレームを埋めつつ被写体が途切れない (横長写真でも全体が映る)。
 */
async function downloadAndCrop(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 背景: 同じ写真を cover で広げてブラー＋減光 (余白を自然に埋める)。
  const bg = await sharp(buf)
    .resize(W, H, { fit: "cover", position: "centre" })
    .blur(48)
    .modulate({ brightness: 0.6 })
    .toBuffer();
  // 前景: 写真全体をフレーム内に収める (cover ではなく inside = 切らない)。
  const fg = await sharp(buf)
    .resize(W, H, { fit: "inside" })
    .toBuffer();
  await sharp(bg)
    .composite([{ input: fg, gravity: "centre" }])
    .jpeg({ quality: 86 })
    .toFile(dest);
}

/** Commons から何も取れなかった時の単色フォールバック (黒画面回避)。 */
async function solidFallback(dest: string, label: string): Promise<void> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#0F1B3D"/>
     </svg>`,
  );
  await sharp(svg).jpeg({ quality: 86 }).toFile(dest);
  void label;
}

/** 国旗 PNG を flagcdn から取得 (640x480, hook の {code}.png と同寸)。 */
async function fetchFlag(code: string, dest: string): Promise<void> {
  const iso = code.toLowerCase();
  const res = await fetch(`https://flagcdn.com/w640/${iso}.png`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`flag HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim().slice(0, 80);
}
async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
