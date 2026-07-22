import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
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
// 本文シーンの背景プール (bg-1=hero, bg-2..BG_COUNT=body)。6→8 に拡大 (2026-06-27):
// シーン分割で本文が 6+ になると bg が見える形で反復し低品質に見える = スワイプ要因。
const BG_COUNT = 8;

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
  const url = `${PEXELS_API}?query=${encodeURIComponent(query)}&per_page=9&orientation=portrait`;
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

// AI hero 背景は **完全無料** の Pollinations (flux モデル・APIキー不要・費用ゼロ) で生成。
// 既定で有効 (AI_HERO=off で無効化可)。story の hero (bg-1 = コールドオープン/ループ画像) を
// 内容を強く想起させるイラストに。ニュース信頼性のため no text・実在人物なし、画面フッターは
// "AI + FILE VISUALS" に切替。生成失敗/タイムアウト時は呼び出し側が stock(Pexels) hero を維持。
const AI_HERO_ON = process.env.AI_HERO !== "off" && process.env.AI_HERO !== "0";
// AI_BEATS: ナレーションの文(=ビート)ごとに1枚のAIイラストを生成し、その文の内容を絵で描く。
// = サウンドオフでも「今喋っている事」が画面に出て分かりやすい。既定ON、AI_BEATS=off で従来のストック回転に戻す。
const AI_BEATS_ON = process.env.AI_BEATS !== "off" && process.env.AI_BEATS !== "0";
// PARALLAX: 2.5Dパララックス動画生成。**既定OFF (2026-07-20)**: 切り出し合成が不自然という
// オーナー実見フィードバックで撤回。レシピは motion-broll スキルに保存済み・PARALLAX=on で再有効化可。
const PARALLAX_ON = process.env.PARALLAX === "on";
// STYLIZE: 実写ストック(Pexels/Commons)を「AIイラスト風」に加工してAI生成ビート画像とトーン統一。
// 既定ON (2026-07-20 オーナー要望)。STYLIZE=off で素の実写に戻る。
const STYLIZE_ON = process.env.STYLIZE !== "off" && process.env.STYLIZE !== "0";
const MAX_BEAT_IMAGES = Number(process.env.MAX_BEAT_IMAGES ?? "8");
// 無料 Pollinations は同時/連続リクエストに 429 を返す。逐次(1)＋リトライ/バックオフが安定。
const BEAT_CONCURRENCY = Number(process.env.BEAT_CONCURRENCY ?? "1");
const POLLINATIONS_API = "https://image.pollinations.ai/prompt/";

// ハイブリッド画質 (2026-07-23): FAL_KEY があれば **hero 画像だけ** fal.ai の高品質モデル
// (既定 FLUX.2 pro) で生成し、ビート画像は無料の Pollinations のまま。hero は1フレーム目/
// ループ画像で最も目立つので、月~180枚だけ有料化しても $8-15/月。FAL_KEY 未設定なら従来の
// 完全無料経路 (Pollinations) にそのままフォールバック。FLUX.2 pro は検閲が緩く紛争/災害の
// ニュース題材も描ける (Google 系 Nano Banana は実在人物/暴力を拒否するため hero には不適)。
const FAL_KEY = process.env.FAL_KEY?.trim();
const FAL_HERO_MODEL = process.env.FAL_HERO_MODEL ?? "fal-ai/flux-2-pro";

type StoryLike = { headline: string; summary?: string; imageQueries?: string[]; beatVisuals?: string[]; country?: { name?: string }; index?: number };

// 時代錯誤・機材誤りの防止 (実測: ホルムズの「船」が帆船で描かれる等)。全AI画像プロンプト共通。
const ACCURACY_TAIL = "Present-day 2026 setting with factually accurate modern equipment and vehicles (modern oil tankers, container ships, warships, current military hardware and uniforms, contemporary buildings and clothing). Absolutely no anachronisms: no ancient or sailing vessels, no historical armor or robes, no medieval or fantasy elements, unless the story itself is historical.";

// 1ストーリー内は画風を固定 (hero + 全ビートで共有) してコヒーレントに。トーンは見出し/要約から判定。
function pickTone(s: StoryLike): string {
  const t = `${s.headline} ${s.summary ?? ""}`.toLowerCase();
  if (/\b(war|strike|attack|missile|troops?|killed|conflict|military|invasion|clash|siege|bomb|shell|airstrike|ceasefire|frontline)\b/.test(t))
    return "somber photojournalistic concept-art, desaturated palette, dramatic volumetric light and haze";
  if (/\b(space|nasa|telescope|rocket|launch|satellite|quantum|robot|chip|semiconductor|\bai\b|software|tech)\b/.test(t))
    return "clean editorial sci-fi concept illustration, cool cinematic palette, crisp rim light";
  if (/\b(quake|earthquake|storm|flood|fire|wildfire|disaster|hurricane|cyclone|rescue|landslide|tsunami|evacuat)\b/.test(t))
    return "dramatic photojournalistic concept-art, dust and haze, urgent muted palette";
  if (/\b(market|economy|trade|oil|stocks?|inflation|bank|deal|tariff|election|vote|court|summit|sanction|talks)\b/.test(t))
    return "muted editorial illustration, restrained palette, clean balanced composition";
  return "painterly photojournalistic concept-art, somber desaturated palette, moody volumetric light";
}
const STYLE_TAIL = "Vertical 9:16 composition, strong foreground subject, deep atmospheric background, shallow depth of field, intricate realistic textures, ultra detailed, immersive. Absolutely no text, no captions, no letters, no numbers, no logos, no watermark, no UI, no borders, no recognizable real individual faces.";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pollinate(prompt: string, seed: number, dest: string, timeoutMs: number): Promise<void> {
  // 1080x1920 直出し。enhance=true は撤去 (2026-07-20): プロンプトをLLMが書き換え、題材から
  // 逸脱した「きれいなだけの絵」になる実害を確認。プロンプトは自前で具体化する方針に。
  const url = `${POLLINATIONS_API}${encodeURIComponent(prompt.slice(0, 1000))}?width=1080&height=1920&nologo=true&model=flux&seed=${seed}`;
  // 429/5xx は無料枠のレート制限/一時障害 → バックオフして再試行。
  const backoffs = [0, 6000, 14000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`pollinations HTTP ${res.status}`);
      if (!res.ok) throw new Error(`pollinations HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) throw new Error("pollinations: empty/too-small image");
      await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).jpeg({ quality: 88 }).toFile(dest);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** fal.ai の高品質モデルで hero を生成 (FAL_KEY 必須)。失敗/未設定は false を返し呼び出し側が無料経路へ。 */
async function falHero(prompt: string, seed: number, dest: string): Promise<boolean> {
  if (!FAL_KEY) return false;
  try {
    const res = await fetch(`https://fal.run/${FAL_HERO_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.slice(0, 2000),
        // FLUX.2 pro は width/height に multiple_of:16 を要求 (1080 は不適合 → 422)。
        // 16の倍数の 1088x1920 で生成し、下の sharp cover-crop で 1080x1920 に確定させる。
        image_size: { width: 1088, height: 1920 },
        seed,
        output_format: "jpeg",
        // ニュース (紛争/災害/実在の場所) が unattended CI で拒否されないよう検閲を緩める。
        enable_safety_checker: false,
        safety_tolerance: "5",
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`fal HTTP ${res.status}`);
    const json = (await res.json()) as { images?: Array<{ url?: string }> };
    const url = json.images?.[0]?.url;
    if (!url) throw new Error("fal: no image url in response");
    const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error(`fal image download HTTP ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length < 2000) throw new Error("fal: empty/too-small image");
    await sharp(buf).resize(W, H, { fit: "cover", position: "centre" }).jpeg({ quality: 90 }).toFile(dest);
    return true;
  } catch (e) {
    console.warn(`[broll] fal hero failed (${e instanceof Error ? e.message : e}) — falling back to free Pollinations`);
    return false;
  }
}

/** hero 画像を生成し、使ったエンジン表示名を返す。FAL_KEY があれば fal.ai を優先、失敗時は無料へ。 */
async function generateAIHero(story: StoryLike, dest: string): Promise<string> {
  const elements = (Array.isArray(story.imageQueries) ? story.imageQueries.slice(0, 4) : [])
    .map(s => String(s).trim()).filter(Boolean).join(", ");
  const ctx = (story.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const prompt = [
    `Highly detailed cinematic editorial news illustration depicting the story: "${story.headline}".`,
    ctx ? `Scene context: ${ctx}` : "",
    elements ? `Key visual elements: ${elements}.` : (story.country?.name ? `Setting: ${story.country.name}.` : ""),
    ACCURACY_TAIL,
    `Style: ${pickTone(story)}.`, STYLE_TAIL,
  ].filter(Boolean).join(" ");
  const seed = (story.index ?? 1) * 7 + 3;
  if (await falHero(prompt, seed, dest)) return `fal.ai ${FAL_HERO_MODEL}`;
  await pollinate(prompt, seed, dest, 60000);
  return "Pollinations, free";
}

// ビート画像: その文(=喋っている瞬間)を「正確に」絵で描く (2026-07-20 正確性強化)。
// 優先順: Routine が書く beatVisuals[i] (文ごとの具体的な視覚描写・被写体/機材/場所を明示)
//   > 要約文の生テキスト (フォールバック)。imageQueries の具体名詞も必ず注入し、
// ACCURACY_TAIL で時代錯誤 (帆船・歴史衣装等) を禁止。画風は hero と同じ pickTone+STYLE_TAIL。
async function generateBeatImage(story: StoryLike, beatText: string, beatIdx: number, dest: string): Promise<void> {
  const hasVisual = Boolean(story.beatVisuals?.[beatIdx]);
  const visual = (story.beatVisuals?.[beatIdx] ?? beatText).replace(/\s+/g, " ").trim().slice(0, 240);
  // imageQueries をローテしつつ2個ずつ使う (ビートごとに画が変わりつつ被写体は常に具体)。
  const iq = Array.isArray(story.imageQueries) ? story.imageQueries.map(s => String(s).trim()).filter(Boolean) : [];
  const elements = iq.length ? [iq[beatIdx % iq.length], iq[(beatIdx + 1) % iq.length]].filter(Boolean).join(", ") : "";
  // 被写体アンカーを先頭に (fluxは先頭トークンを重視)。beatVisuals が無い時の要約文フォールバックは
  // 抽象文 (特に最終の分析文) で被写体が消えるため、必ず imageQueries の具体名詞で画を固定する。
  const prompt = [
    elements ? `Editorial news illustration of: ${elements}.` : `Editorial news illustration for: "${story.headline}".`,
    hasVisual ? `Exact scene: "${visual}".` : `Scene context: "${story.headline}" — ${visual}`,
    ACCURACY_TAIL,
    `Style: ${pickTone(story)}.`, STYLE_TAIL,
  ].filter(Boolean).join(" ");
  await pollinate(prompt, (story.index ?? 1) * 100 + beatIdx, dest, 45000);
}

/** 要約を文(ビート)に分割。短すぎる断片は除外、MAX_BEAT_IMAGES で上限。 */
function splitBeats(summary: string): string[] {
  return (summary ?? "")
    .replace(/\s+/g, " ").trim()
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 3)
    .slice(0, MAX_BEAT_IMAGES);
}

/** 2.5Dパララックス: rembg で前景を切り出し、背景=遅ズーム/前景=ドリフトの2層合成で
 *  6秒の「動く映像」クリップ (motion.mp4) を作る。失敗時は throw → 呼び出し側でスキップ。 */
async function generateParallax(beatJpg: string, beatIdx: number): Promise<void> {
  const fg = beatJpg.replace(/\.jpg$/, ".fg.png");
  const motion = beatJpg.replace(/\.jpg$/, ".motion.mp4");
  await runQuiet("python3", [path.join("scripts", "cutout.py"), beatJpg, fg]);
  const st = await fs.stat(fg);
  if (st.size < 5000) throw new Error("cutout produced empty foreground");
  // 前景は6%拡大+左右ドリフト(±14px・ビートごとに方向交互)、背景は5%スローズーム。
  const dir = beatIdx % 2 === 0 ? 1 : -1;
  const drift = `(main_w-overlay_w)/2+${dir}*28*(t/6-0.5)`;
  await runQuiet("ffmpeg", [
    "-y",
    "-loop", "1", "-t", "6", "-i", beatJpg,
    "-loop", "1", "-t", "6", "-i", fg,
    "-filter_complex",
    `[0:v]scale=${2 * W}:${2 * H},zoompan=z='1.0+0.05*on/179':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=30:s=${W}x${H}[bg];` +
    `[1:v]scale=${Math.round(W * 1.06)}:${Math.round(H * 1.06)}[fgs];` +
    `[bg][fgs]overlay=x='${drift}':y='(main_h-overlay_h)/2',format=yuv420p`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
    motion,
  ]);
}

function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    proc.on("error", reject);
    proc.on("close", (code: number) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(-200)}`))));
  });
}

/** 配列を上限並列で処理 (Pollinations のレイテンシ対策)。 */
async function runBounded<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
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
      const dest = path.join(assets, `bg-${code}-s${story.index}-${i + 1}.jpg`);
      try {
        await downloadAndCrop(img.thumbUrl, dest);
        savedBg.push(i + 1);
        creditLines.push(`- bg-${code}-s${story.index}-${i + 1}.jpg — ${img.title} (${img.license || "see Commons"}) ${img.artist ? `by ${stripHtml(img.artist)}` : ""}\n  ${img.descUrl}`);
      } catch (e) {
        console.warn(`[broll] download/crop failed (${img.title}): ${e instanceof Error ? e.message : e}`);
      }
    }

    // 1 枚も取れなかった場合: 国名のみで広く再検索 → それでもダメなら単色フォールバック。
    if (savedBg.length === 0) {
      const fallbackImgs = await searchImages(countryName).catch(() => [] as CommonsImage[]);
      for (let i = 0; i < fallbackImgs.length && savedBg.length < BG_COUNT; i++) {
        const dest = path.join(assets, `bg-${code}-s${story.index}-${savedBg.length + 1}.jpg`);
        try {
          await downloadAndCrop(fallbackImgs[i].thumbUrl, dest);
          savedBg.push(savedBg.length + 1);
          creditLines.push(`- bg-${code}-s${story.index}-${savedBg.length}.jpg — ${fallbackImgs[i].title} (fallback)\n  ${fallbackImgs[i].descUrl}`);
        } catch { /* keep trying */ }
      }
    }
    if (savedBg.length === 0) {
      await solidFallback(path.join(assets, `bg-${code}-s${story.index}-1.jpg`), countryName);
      savedBg.push(1);
      creditLines.push(`- bg-${code}-s${story.index}-1.jpg — solid-color fallback (no Commons image found)`);
      console.warn(`[broll] ${code}: no Commons image, used solid fallback`);
    }

    // bg-1..6 を必ず揃える: 不足分は取得済みを cycle してコピー。
    for (let n = 1; n <= BG_COUNT; n++) {
      const target = path.join(assets, `bg-${code}-s${story.index}-${n}.jpg`);
      if (await exists(target)) continue;
      const src = path.join(assets, `bg-${code}-s${story.index}-${savedBg[(n - 1) % savedBg.length]}.jpg`);
      await fs.copyFile(src, target).catch(() => {});
    }

    // AI hero: キーがあれば bg-1 (コールドオープン/ループ画像) を AI生成で上書き。body(bg-2..6)は Pexels のまま。
    // 失敗/コンテンツ拒否 (戦争・実在人物等で起こりうる) 時は stock の hero を維持 (無害なフォールバック)。
    if (AI_HERO_ON) {
      try {
        const engine = await generateAIHero(story, path.join(assets, `bg-${code}-s${story.index}-1.jpg`));
        creditLines.push(`- bg-${code}-s${story.index}-1.jpg — AI illustration (${engine})`);
        console.log(`[broll] ${code}: AI hero generated (${engine})`);
      } catch (e) {
        console.warn(`[broll] AI hero gen failed (${code}): ${e instanceof Error ? e.message : e} — keeping stock hero`);
      }
    }

    // ビート画像: 要約の文ごとに1枚のAIイラストを生成 (beat-{code}-s{index}-b{n}.jpg)。
    // build-news-video が body cue i にこれを割り当て、その文の内容を絵で描く=分かりやすい。
    // 失敗/拒否時はファイルを書かない → build 側が stock(bg) にフォールバック (黒画面なし)。
    if (AI_BEATS_ON) {
      const beats = splitBeats(story.summary ?? "");
      let okBeats = 0;
      await runBounded(beats, BEAT_CONCURRENCY, async (beatText, bi) => {
        const dest = path.join(assets, `beat-${code}-s${story.index}-b${bi + 1}.jpg`);
        try {
          await generateBeatImage(story, beatText, bi, dest);
          okBeats++;
        } catch (e) {
          console.warn(`[broll] beat gen failed (${code} b${bi + 1}): ${e instanceof Error ? e.message : e} — will fall back to stock`);
        }
      });
      creditLines.push(`- beat-${code}-s${story.index}-b1..${okBeats}.jpg — AI beat illustrations (Pollinations flux, free)`);
      console.log(`[broll] ${code}: ${okBeats}/${beats.length} beat images generated`);

      // 2.5Dパララックス化 (rembg 前景分離 + 2層合成 → motion.mp4)。逐次・失敗はスキップ。
      if (PARALLAX_ON && okBeats > 0) {
        let okMotion = 0;
        for (let bi = 0; bi < beats.length; bi++) {
          const beatJpg = path.join(assets, `beat-${code}-s${story.index}-b${bi + 1}.jpg`);
          if (!(await exists(beatJpg))) continue;
          try {
            await generateParallax(beatJpg, bi);
            okMotion++;
          } catch (e) {
            console.warn(`[broll] parallax failed (${code} b${bi + 1}): ${e instanceof Error ? e.message : e} — still image fallback`);
          }
        }
        console.log(`[broll] ${code}: ${okMotion}/${beats.length} parallax motion clips generated`);
      }
    }

    // 国旗 PNG
    await fetchFlag(story.country.code, path.join(assets, `${code}.png`)).catch(e => {
      console.warn(`[broll] flag fetch failed (${code}): ${e instanceof Error ? e.message : e}`);
    });

    creditLines.push("");
    console.log(`[broll] ${code}: ${savedBg.length} unique bg saved, bg-1..${BG_COUNT} ensured`);
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
  const composed = await sharp(bg)
    .composite([{ input: fg, gravity: "centre" }])
    .toBuffer();
  if (STYLIZE_ON) {
    // 実写ストックを「AIイラスト風」に統一 (2026-07-20): median=筆致的な平滑 → 彩度/明度ブースト →
    // 再シャープでエッジを立てる = AI生成ビート画像とトーンが揃い、実写とイラストの混在感を消す。
    await sharp(composed)
      .median(5)
      .modulate({ saturation: 1.3, brightness: 1.04 })
      .sharpen({ sigma: 1.4 })
      .jpeg({ quality: 86 })
      .toFile(dest);
  } else {
    await sharp(composed).jpeg({ quality: 86 }).toFile(dest);
  }
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
