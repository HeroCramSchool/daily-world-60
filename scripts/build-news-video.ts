import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fitSingleLine, fitTextBox, textWidthEm, clampAttr } from "./lib/textfit.js";
import { MAP_W, MAP_H, worldDots, countryLonLat, lonLatToXY } from "./lib/worldmap.js";

/**
 * 1 ストーリー単独動画を構築する (v8: 尺=音声長に動的化, 字幕同期 + 国旗なし body)。
 *
 * シーン構成:
 *   Hook       : 0 → "comes from" cue 終了 (≈4s)
 *                  → 国旗 + 国名 + headline 大字 + "TODAY'S NEWS"
 *   Captions   : headline cue → keyword cue 開始
 *                  → 各 cue を 1 scene 化、cue text を下部字幕として表示
 *                  → 背景画像 4 枚を cue index で cycle
 *                  → 上部に headline (compact) を常時 (国旗なし)
 *   Word card  : keyword cue → subscribe cue 開始
 *                  → 単語大字 + 定義中央寄せ
 *   Subscribe  : outro cue ("thanks for watching") → 音声末尾 (≈5s)
 *                  → PLEASE SUBSCRIBE + 👍 + チャンネル名
 *
 * 入力:
 *   output/YYYY-MM-DD/script-en.json
 *   output/YYYY-MM-DD/voice-{code}.mp3, voice-{code}.vtt
 *   output/YYYY-MM-DD/_assets/bg-{code}-1..4.jpg, {code}.png
 */

const W = 1080;
const H = 1920;
const FPS = 30;

// ─── リテンション設計フラグ (2026-06-27, 10K構成) ───
// MOTION: 全シーンに Ken Burns (静止画スライドショーがスワイプ最大要因)。問題時 MOTION=off で即無効化。
const MOTION = process.env.MOTION !== "off" && process.env.MOTION !== "0";
// ズーム量。大きいほど動くが端が切れ、文字の可読性も落ちる。4% (長尺化したシーンで≈1%/s) に減速
// (2026-07-10: 連続モーションはテキスト処理と競合する EEG 研究知見・「速すぎ」フィードバック反映)。
const KB_ZOOM = Number(process.env.KEN_BURNS_ZOOM ?? "0.04");
// KEYWORD_CARD: 単色の英単語スラブ(リテンションキラー)。既定 off。ナレーションに語彙節があっても描画しない。
const KEYWORD_CARD = process.env.KEYWORD_CARD === "on";
// 可読性ペーシング (2026-07-10 基準準拠に補正。「速すぎ」実フィードバック+Netflix/TED/BBC基準):
// - チャンク表示は最低 MIN_CHUNK_SEC (DCMP≈1.33s/TED≈1.12s/Netflix絶対下限0.83sの安全側)
// - 分割は5秒毎 (映画の現代ASL 4-6秒帯・Netflixテキスト最大7秒の内側)。旧3秒は倍速すぎた
// - 1チャンク5語 (≈28字 = Netflix/TED 42字/行の内側・15CPSで約1.9秒)
const MAX_SCENE_SEC = Number(process.env.MAX_SCENE_SEC ?? "5");
const MAX_WORDS_PER_CHUNK = Number(process.env.MAX_WORDS_PER_CHUNK ?? "5");
const MIN_CHUNK_SEC = Number(process.env.MIN_CHUNK_SEC ?? "1.3");
// body 背景プール (bg-2..8 = 7枚)。fetch-broll が bg-1..8 を必ず用意する。
const BODY_BG = 7;
// 本文の最初のビートを「動くドット世界地図」にする (米国ニュース風・国へズーム)。MAP_INTRO=off で無効。
const MAP_INTRO = process.env.MAP_INTRO !== "off" && process.env.MAP_INTRO !== "0";
// カラオケ字幕: 既定OFF (2026-07-10)。査読研究では単語追従ハイライトは「先読み」を阻害し
// ESL読者の理解を下げる (Jensema 1998/Rajendran 2013)。KARAOKE=on でA/B用に再有効化可。
const KARAOKE = process.env.KARAOKE === "on";
// inauthentic-content 対策のビジュアル微差: story ごとにアクセント色を輪番 (ブランド黄は stripe/国名で維持)。
const ACCENTS = ["#F5E63B", "#FFB347", "#5EEAD4"];
function accentFor(storyIndex: number): string {
  return ACCENTS[Math.max(0, (storyIndex - 1)) % ACCENTS.length];
}

interface Country { code: string; flag: string; name?: string; }
interface Keyword { word: string; definitionEn: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  keyword?: Keyword;
  /** 3-6語の画面用フック (数字入り推奨)。無ければ headline で代用。 */
  hookText?: string;
  hookPattern?: string;
}
interface ScriptJson {
  date: string;
  stories: Story[];
}

interface VttCue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  for (const story of script.stories) {
    await buildOne(dir, story);
  }
}

async function buildOne(dir: string, story: Story) {
  const code = story.country.code.toLowerCase();
  const audio = path.join(dir, `voice-${code}.mp3`);
  const vtt = path.join(dir, `voice-${code}.vtt`);
  const out = path.join(dir, `news-${story.index}-${code}.mp4`);

  const cues = await parseVtt(vtt);
  const audioDuration = await ffprobeDuration(audio);
  // 動画尺は音声長に合わせる (60秒固定をやめる)。本文が長い回でも末尾が切れない。
  const total = audioDuration + 0.4;

  // Key cue indices (新ナレーション: cold open → "Here's what's happening." → summary
  //   → "Quick English check..." → "And that's the latest from X.")
  // 旧ナレーションの表現もフォールバックで検出する。
  const countryCueIdx = cues.findIndex(c => /here's what's happening|comes from|news from/i.test(c.text));
  const wordCueIdx = cues.findIndex(c => /quick english check|english keyword|english word|keyword from today's news|word of the day/i.test(c.text));
  const outroCueIdx = cues.findIndex(c => /that's the latest|thanks for watching|subscribe/i.test(c.text));

  const tHookEnd = countryCueIdx >= 0 ? cues[countryCueIdx].end : 4;

  // ─── Caption scenes (body) ───
  const bodyStartIdx = countryCueIdx + 1;
  const bodyEndIdx = wordCueIdx >= 0 ? wordCueIdx
    : outroCueIdx >= 0 ? outroCueIdx
    : cues.length;
  const bodyCues = cues.slice(bodyStartIdx, bodyEndIdx);

  // ─── Word scenes ───
  // 既定で無効 (KEYWORD_CARD=on のときのみ)。body は依然 wordCueIdx で終端するので、
  // 仮にナレーションに語彙節が残っても本文字幕には混ざらない (その分の尺は末尾ループが吸収)。
  const wordCues = (KEYWORD_CARD && wordCueIdx >= 0)
    ? cues.slice(wordCueIdx, outroCueIdx >= 0 ? outroCueIdx : cues.length)
    : [];

  // ─── Outro cues: bg-1 (フックと同じ画像) に戻る = ループ接続。エンドカードは置かない ───
  const outroCues = outroCueIdx >= 0 ? cues.slice(outroCueIdx) : [];

  // ─── Scene list ───
  // fx/fy: 指定時はその焦点(フレーム比)へズームイン (地図の国へ寄る動き)。
  // zStart/zEnd: ビート画像シーンの連続ズーム範囲 (同じ画像を共有する cue 内チャンクで継ぎ目なく寄る)。
  // svgs/wordDurs: カラオケ字幕 (単語ごとのSVG変種を concat し、単一エンコードで連続ズーム)。
  type Scene = { id: string; dur: number; svg?: string; svgs?: string[]; wordDurs?: number[]; fx?: number; fy?: number; zStart?: number; zEnd?: number };
  const scenes: Scene[] = [];
  const mapCoords = MAP_INTRO ? countryLonLat(story.country.code) : null;

  // カラオケ用の単語タイムスタンプ (tts-per-story v2 が生成。無ければ空=従来表示)
  const speechWords: VttCue[] = KARAOKE
    ? await parseVtt(path.join(dir, `voice-${code}.words.vtt`)).catch(() => [] as VttCue[])
    : [];

  // ビート画像 (beat-{code}-s{index}-bN.jpg) を順に収集。各 body cue に1枚割り当てて文の内容を絵で描く。
  // 無い回 (AI_BEATS=off / 生成失敗) は空配列 → 従来のストック背景回転にフォールバック。
  const beatList: string[] = [];
  for (let n = 1; n <= 12; n++) {
    const f = `beat-${code}-s${story.index}-b${n}.jpg`;
    if (await fs.access(path.join(dir, "_assets", f)).then(() => true).catch(() => false)) beatList.push(f);
  }

  // Hook
  scenes.push({
    id: "01-hook",
    dur: tHookEnd,
    svg: hookSvg(story),
  });

  // Body cues: キネティック字幕。各 cue を「尺(MAX_SCENE_SEC)」と「語数(MAX_WORDS_PER_CHUNK)」の
  // 両方で割って 3-6語の短いチャンクに分割し、チャンクごとに新カット(bg-2..8循環)＋モーションで
  // ポン出しする。= サウンドオフでも要点が次々切り替わり、静止スライド感を消す (リテンション)。
  // 時間は均等割りなので音声とほぼ同期 (cue内の発話は概ね線形)。
  let bgTick = 0;
  bodyCues.forEach((cue, i) => {
    const dur = cue.end - cue.start;
    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    // 分割数は語数/尺の要求と「最低表示 MIN_CHUNK_SEC」の両立で決める。
    // 短い文に語が詰まっている場合は語数要求を諦めて長め表示を優先 (可読性 > 語数上限)。
    const wantParts = Math.max(1, Math.ceil(dur / MAX_SCENE_SEC), Math.ceil(words.length / MAX_WORDS_PER_CHUNK));
    const parts = Math.max(1, Math.min(wantParts, Math.floor(dur / MIN_CHUNK_SEC) || 1));
    const partDur = dur / parts;
    const chunks = chunkWords(words, parts);
    // この cue(=文) に対応するビート画像 (順序対応・件数差はクランプ吸収)。
    const beatFile = beatList.length ? beatList[Math.min(i, beatList.length - 1)] : null;
    // カラオケ: 表示トークン数と発話トークン数の差 (句読点/数値の結合等) はリサンプリングで吸収。
    const cueWords = speechWords.filter(w => w.start >= cue.start - 0.06 && w.end <= cue.end + 0.06);
    const displayDurs = (cueWords.length >= 2 && words.length > 0)
      ? resampleDurs(cueWords.map(w => Math.max(0.08, w.end - w.start)), words.length)
      : null;
    let wordOff = 0;
    for (let k = 0; k < parts; k++) {
      const id = `02-cap${(i + 1).toString().padStart(2, "0")}-${(k + 1).toString().padStart(2, "0")}`;
      const chunkText = chunks[k] || cue.text;
      const nWords = chunkText.split(/\s+/).filter(Boolean).length;
      // 背景は「文(cue)ごと」に1枚 = カットは文の切り替わりだけ (旧: チャンク毎カット=1.5-3秒毎は
      // 映画ASL 4-6秒帯の倍速で、情報系には過負荷。2026-07-10 減速)。文内は連続ズームで繋ぐ。
      const bgFile = beatFile ?? `bg-${code}-s${story.index}-${(i % BODY_BG) + 2}.jpg`;
      const zoom = { zStart: 1 + KB_ZOOM * (k / parts), zEnd: 1 + KB_ZOOM * ((k + 1) / parts) };
      // 最初の本文ビートを地図ズームに置換 (国に座標がある時のみ)。尺は据え置き=音声同期は不変。
      if (bgTick === 0 && mapCoords) {
        const m = mapSvg(story, mapCoords);
        scenes.push({ id: `02-map`, dur: partDur, svg: m.svg, fx: m.fx, fy: m.fy });
      } else if (displayDurs && nWords >= 2) {
        // カラオケ字幕: 発話中の単語をアクセント色に。チャンク内は単語SVG変種のconcat+連続ズームで単一エンコード。
        const raw = displayDurs.slice(wordOff, wordOff + nWords);
        const scale = partDur / raw.reduce((a, b) => a + b, 0);
        scenes.push({
          id, dur: partDur,
          svgs: raw.map((_, wi) => captionSvg(story, chunkText, bgFile, bgTick, wi)),
          wordDurs: raw.map(d => d * scale),
          zStart: (zoom as { zStart?: number }).zStart ?? 1,
          zEnd: (zoom as { zEnd?: number }).zEnd ?? 1 + KB_ZOOM,
        });
      } else {
        scenes.push({ id, dur: partDur, svg: captionSvg(story, chunkText, bgFile, bgTick), ...zoom });
      }
      wordOff += nWords;
      bgTick++;
    }
  });

  // Word card: 各 word cue を 1 scene 化 (大字表示)
  wordCues.forEach((cue, i) => {
    const dur = cue.end - cue.start;
    scenes.push({
      id: `03-word${(i + 1).toString().padStart(2, "0")}`,
      dur,
      svg: wordSvg(story.keyword, cue.text, i, story),
    });
  });

  // Outro: 末尾はフック画面に戻す = シームレスループ (Shorts の自動ループで end→start が繋がり
  // 再視聴を誘発)。旧「PLEASE SUBSCRIBE」の死に区間は廃止 (2026-06-20 リテンション改善)。尺も短くキャップ。
  if (outroCues.length) {
    const outroDur = outroCues.reduce((acc, c) => acc + (c.end - c.start), 0);
    scenes.push({ id: "04-loop", dur: Math.max(1.2, Math.min(2.5, outroDur)), svg: hookSvg(story) });
  }

  // 端数 (audio + 0.4s pad) は最終シーンに吸収させる
  const usedSoFar = scenes.reduce((acc, s) => acc + s.dur, 0);
  const pad = total - usedSoFar;
  if (pad > 0.05 && scenes.length > 0) scenes[scenes.length - 1].dur += pad;

  console.log(`[news] ${code} (story ${story.index}): audio=${audioDuration.toFixed(1)}s, total=${total.toFixed(1)}s, scenes=${scenes.length} (body=${bodyCues.length}, word=${wordCues.length}, outro=${outroCues.length})`);
  console.log(`[news]   hook end=${tHookEnd.toFixed(2)} outro start=${outroCueIdx >= 0 ? cues[outroCueIdx].start.toFixed(2) : "n/a"}`);

  // ─── Render scenes ───
  const segments: string[] = [];
  const tmpFiles: string[] = [];
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si];
    const mp4Path = path.join(dir, `_n${story.index}-${sc.id}.mp4`);
    const isLoopTail = sc.id.startsWith("04-loop");
    if (sc.svgs && sc.wordDurs) {
      // カラオケ: 単語ごとのPNG変種を concat demuxer で並べ、fps化→連続ズームで単一エンコード。
      const pngs: string[] = [];
      for (let wi = 0; wi < sc.svgs.length; wi++) {
        const svgPath = path.join(dir, `_n${story.index}-${sc.id}-w${wi}.svg`);
        const pngPath = path.join(dir, `_n${story.index}-${sc.id}-w${wi}.png`);
        await fs.writeFile(svgPath, sc.svgs[wi], "utf-8");
        await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
        await fs.unlink(svgPath).catch(() => {});
        pngs.push(pngPath);
        tmpFiles.push(pngPath);
      }
      const listPath = path.join(dir, `_n${story.index}-${sc.id}.txt`);
      const listBody = pngs.map((p, wi) => `file '${path.resolve(p)}'\nduration ${sc.wordDurs![wi].toFixed(3)}`).join("\n")
        + `\nfile '${path.resolve(pngs[pngs.length - 1])}'\n`;
      await fs.writeFile(listPath, listBody, "utf-8");
      tmpFiles.push(listPath);
      await run("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-t", Math.max(0.1, sc.dur).toFixed(3),
        "-vf", `fps=${FPS},${kbVf(sc.dur, sc.zStart ?? 1, sc.zEnd ?? 1 + KB_ZOOM)}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
        mp4Path,
      ]);
    } else {
      const svgPath = path.join(dir, `_n${story.index}-${sc.id}.svg`);
      const pngPath = path.join(dir, `_n${story.index}-${sc.id}.png`);
      await fs.writeFile(svgPath, sc.svg ?? "", "utf-8");
      await run("rsvg-convert", ["-w", String(W), "-h", String(H), svgPath, "-o", pngPath]);
      await fs.unlink(svgPath).catch(() => {});
      tmpFiles.push(pngPath);
      // 末尾ループは静止 (zoom=1.0) = フック1フレーム目と完全一致 → 自動リピートが継ぎ目なし。
      const vf = sc.fx !== undefined && sc.fy !== undefined
        ? mapVf(sc.dur, sc.fx, sc.fy)                       // 地図: 国の焦点へズームイン
        : sc.zStart !== undefined
          ? kbVf(sc.dur, sc.zStart, sc.zEnd ?? sc.zStart)   // ビート画像: cue内で連続ズーム
          : sceneVf(sc.dur, si, isLoopTail);
      await run("ffmpeg", [
        "-y", "-loop", "1", "-i", pngPath,
        "-t", Math.max(0.1, sc.dur).toFixed(3),
        "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
        mp4Path,
      ]);
    }
    segments.push(mp4Path);
  }

  // Concat + audio
  const listFile = path.join(dir, `_concat-${code}.txt`);
  await fs.writeFile(listFile, segments.map(s => `file '${path.resolve(s)}'`).join("\n"), "utf-8");
  const bgVideo = path.join(dir, `_bg-${code}.mp4`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", bgVideo]);
  await fs.unlink(listFile).catch(() => {});

  // BGM (news bed) をナレーションの下に低音量でミックス。
  // assets/news-bed.mp3 (または BGM_PATH) が無ければ BGM なしで従来どおり。
  const bgmFile = process.env.BGM_PATH ?? path.join("assets", "news-bed.mp3");
  const hasBgm = await fs.access(bgmFile).then(() => true).catch(() => false);
  // BGM はナレーションをキーにした自動ダッキング (声の間だけ下がる)。既定0.25はダッキング前提の
  // プリレベル (旧固定 0.10 より存在感を出しつつ声は常に前)。最終段で -14 LUFS (YouTube正規化目標)。
  const bgmVol = process.env.BGM_VOLUME ?? "0.25";
  const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";

  const muxArgs = hasBgm
    ? [
        "-y",
        "-i", bgVideo,
        "-i", audio,
        "-stream_loop", "-1", "-i", bgmFile,
        "-filter_complex",
        `[1:a]asplit=2[vo][key];[2:a]volume=${bgmVol}[bgp];` +
        `[bgp][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[bg];` +
        `[vo][bg]amix=inputs=2:duration=first:normalize=0[mix0];[mix0]${LOUDNORM}[mix]`,
        "-map", "0:v:0", "-map", "[mix]",
        "-t", total.toFixed(2),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-r", String(FPS),
        out,
      ]
    : [
        "-y",
        "-i", bgVideo,
        "-i", audio,
        "-filter_complex", `[1:a]${LOUDNORM}[mix]`,
        "-map", "0:v:0", "-map", "[mix]",
        "-t", total.toFixed(2),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-r", String(FPS),
        out,
      ];
  if (hasBgm) console.log(`[news] ${code}: mixing BGM (${bgmFile}, vol ${bgmVol})`);
  await run("ffmpeg", muxArgs);

  // Cleanup
  for (const s of segments) await fs.unlink(s).catch(() => {});
  await fs.unlink(bgVideo).catch(() => {});
  for (const f of tmpFiles) await fs.unlink(f).catch(() => {});

  const stat = await fs.stat(out);
  console.log(`[news] → ${out} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

// ─────────── SVG scene builders ───────────

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 数字トークン (件数/%/金額/日付) をアクセント色でハイライト = サウンドオフで要点が即伝わる。 */
function emphasizeNumbers(s: string, accent = "#F5E63B"): string {
  return escape(s).replace(/([$£€]?\d[\d.,:]*%?\+?)/g, `<tspan fill="${accent}">$1</tspan>`);
}

/** カラオケ行: 単語ごとに tspan 化し、発話中 (globalIdx===highlightIdx) と数字をアクセント色に。 */
function karaokeLine(line: string, startIdx: number, highlightIdx: number, accent: string): string {
  return line.split(/\s+/).filter(Boolean).map((tok, j) => {
    const hot = startIdx + j === highlightIdx || /\d/.test(tok);
    return `<tspan fill="${hot ? accent : "#FFFFFF"}">${escape(tok)}</tspan>`;
  }).join(" ");
}

/** 発話トークンの duration 列を表示トークン数 n に線形リサンプリング (累積時間を等分割補間)。 */
function resampleDurs(raw: number[], n: number): number[] {
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 0) || n <= 0) return Array(Math.max(1, n)).fill(0.2);
  const cum: number[] = [0];
  for (const d of raw) cum.push(cum[cum.length - 1] + d);
  const at = (f: number) => {
    // f∈[0,1] → 累積時間 (raw インデックス空間で線形補間)
    const x = f * raw.length;
    const i = Math.min(raw.length - 1, Math.floor(x));
    return cum[i] + (x - i) * raw[i];
  };
  const out: number[] = [];
  for (let j = 0; j < n; j++) out.push(Math.max(0.06, at((j + 1) / n) - at(j / n)));
  return out;
}

/** words を n 個の語数バランスの取れたチャンクに分割 (キネティック字幕用)。 */
function chunkWords(words: string[], n: number): string[] {
  if (n <= 1 || words.length <= 1) return [words.join(" ")];
  const out: string[] = [];
  const base = Math.floor(words.length / n);
  let rem = words.length % n;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const take = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    out.push(words.slice(idx, idx + take).join(" "));
    idx += take;
  }
  return out;
}

/** Compact source URL: domain + first 40 chars of path. */
function shortUrl(url: string, maxLen = 56): string {
  const trimmed = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

/**
 * テキストフィットは lib/textfit.ts の実測幅エンジンに委譲する。
 * (一律係数による過小評価ではみ出した事故の再発防止。全テキスト要素で使用。)
 */
function fitKeywordFontSize(word: string, maxWidth = 900, ceilingFontSize = 220): number {
  return fitSingleLine(word.toUpperCase(), maxWidth, ceilingFontSize);
}

function fitCaption(
  text: string,
  boxW: number,
  boxH: number,
  candidates = [64, 58, 52, 48, 44, 40, 36, 32, 28, 24],
): { fontSize: number; lines: string[]; lineHeight: number } {
  return fitTextBox(text, boxW, boxH, candidates);
}

/**
 * Source attribution footer (Y 1820-1910). Shown on every scene.
 * 右側に AI 音声・file photo の常時開示 (inauthentic 対策)。
 * source 行は実測幅で 760px に収まるフォントサイズに自動縮小。
 */
function sourceFooter(story: Story): string {
  const srcLine = `${story.sourceName} · ${shortUrl(story.sourceUrl)}`;
  const srcFs = fitSingleLine(srcLine, 760, 22);
  return `
  <!-- Source attribution footer -->
  <rect x="0" y="1820" width="${W}" height="100" fill="#0A0A0A" fill-opacity="0.92"/>
  <rect x="0" y="1820" width="${W}" height="3" fill="#F5E63B"/>
  <text x="60" y="1862" font-family="Hiragino Sans" font-weight="900"
        font-size="24" fill="#F5E63B" letter-spacing="4">SOURCE</text>
  <text x="${W - 60}" y="1862" text-anchor="end" font-family="Hiragino Sans" font-weight="600"
        font-size="20" fill="#9CA3AF" letter-spacing="1">${process.env.AI_HERO !== "off" && process.env.AI_HERO !== "0" ? "AI VOICE · AI + FILE VISUALS" : "AI VOICE · FILE PHOTOS"}</text>
  <text x="60" y="1900" font-family="Hiragino Sans" font-weight="600"
        font-size="${srcFs}" fill="#FFFFFF" letter-spacing="0"${clampAttr(srcLine, srcFs, 760, 0)}>${escape(srcLine)}</text>`;
}
function wrap(text: string, maxChars: number, maxLines = 5): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur.trim());
  return lines.slice(0, maxLines);
}

/**
 * Hook (1フレーム目=サムネイル設計):
 *   - 劇的写真をほぼ素のまま主役に (暗幕は下部のみ)
 *   - 特大フックテキスト (hookText 3-6語、無ければ headline)
 *   - 国旗+国名は左上の小チップに格下げ
 */
function hookSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const countryName = story.country.name ?? story.country.code;
  const cnText = countryName.toUpperCase();
  const cnFs = fitSingleLine(cnText, 560, 40);

  // 特大フック: hookText 優先 (大文字化)。fallback は headline (文そのまま)。
  const hookRaw = story.hookText?.trim() || story.headline;
  const isShortHook = Boolean(story.hookText?.trim());
  const hookShown = isShortHook ? hookRaw.toUpperCase() : hookRaw;
  const boxY = 980, boxH = 660;
  const hFit = fitTextBox(hookShown, 960, boxH,
    isShortHook ? [120, 110, 100, 92, 84, 76, 68, 60, 52] : [76, 68, 62, 56, 50, 46, 42, 38, 34]);
  const totalH = hFit.lines.length * hFit.lineHeight;
  const startY = boxY + (boxH - totalH) + hFit.fontSize - Math.round(hFit.fontSize * 0.2);
  let hookSvgText = "";
  hFit.lines.forEach((line, i) => {
    hookSvgText += `\n  <text x="60" y="${startY + i * hFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hFit.fontSize}" fill="#FFFFFF" letter-spacing="-1"${clampAttr(line, hFit.fontSize, 960, -1)}>${escape(line)}</text>`;
  });

  // 国名チップ: テキスト幅から算出、ただし右マージン 60px を超えないよう上限クランプ。
  const chipTextX = 208;
  const chipMaxTextW = W - 60 - chipTextX; // 国名テキストが使える最大幅 (= 812)
  const cnClamp = clampAttr(cnText, cnFs, chipMaxTextW, 1);
  // chip 背景は実フォント (推定より太い) を必ず内包するよう推定幅を 1.1x 膨らませる。
  const cnDrawW = Math.min(chipMaxTextW, Math.ceil((textWidthEm(cnText) * cnFs + (cnText.length - 1) * 1) * 1.1));
  const chipW = Math.min(W - 120, chipTextX - 60 + cnDrawW + 28);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="hookDarken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"  stop-color="#0A0A0A" stop-opacity="0.35"/>
      <stop offset="45%" stop-color="#0A0A0A" stop-opacity="0.12"/>
      <stop offset="62%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.94"/>
    </linearGradient>
  </defs>
  <!-- Dramatic photo is the hero -->
  <image href="_assets/bg-${code}-s${story.index}-1.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#hookDarken)"/>

  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>

  <!-- Country chip: flag + name。右上ブランドは廃止 (長い国名との衝突防止)。
       テキストは chipMaxTextW を超えると自動圧縮 = 絶対にはみ出さない。 -->
  <rect x="60" y="110" width="${chipW}" height="96" rx="14" fill="#0A0A0A" fill-opacity="0.78"/>
  <image href="_assets/${code}.png" x="84" y="128" width="96" height="60"
         preserveAspectRatio="xMidYMid meet"/>
  <text x="${chipTextX}" y="172" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="1"${cnClamp}>${escape(cnText)}</text>

  ${hookSvgText}
  ${sourceFooter(story)}
</svg>`;
}

/**
 * Caption scene (body):
 *   - bg image (full-bleed) with darken gradient
 *   - top: country chip + headline (compact, 国旗なし)
 *   - bottom: caption text (current cue text)
 */
function captionSvg(story: Story, captionText: string, bgFile: string, sceneIdx = 0, highlightIdx = -1): string {
  const accent = accentFor(story.index);
  const countryName = story.country.name ?? story.country.code;
  const cnText = countryName.toUpperCase();
  // 国名行: letter-spacing 6 の分を概算で引いた幅に実測フィット + 絶対クランプ (x=60, 右マージン60 → 幅960)
  const cnFs = fitSingleLine(cnText, 960 - cnText.length * 6, 40);
  const cnClamp = clampAttr(cnText, cnFs, 960, 6);
  // Top headline area: Y 200-460 (260px height、上にコンパクトに) x=60 w=960
  const hlBoxW = 960, hlBoxH = 260, hlBoxY = 200;
  const hlFit = fitCaption(story.headline, hlBoxW, hlBoxH,
                           [52, 46, 42, 38, 34, 30, 28, 24]);
  const hlStartY = hlBoxY + hlFit.fontSize + 8;
  let headlineSvg = "";
  hlFit.lines.forEach((line, i) => {
    headlineSvg += `\n  <text x="60" y="${hlStartY + i * hlFit.lineHeight}" font-family="Hiragino Sans" font-weight="900"
        font-size="${hlFit.fontSize}" fill="#FFFFFF" letter-spacing="-1"${clampAttr(line, hlFit.fontSize, hlBoxW, -1)}>${escape(line)}</text>`;
  });
  // Caption box は固定位置 (Y=1240)。旧 1260/1180 交互は「ランダム」に見えて視線誘導を乱すため廃止
  // (2026-06-27)。アクセントバーは常時。font は大きめ優先 (サウンドオフ可読性)。
  const boxX = 40, boxY = 1240, boxW = 1000, boxH = 520;
  // font は中庸サイズ (72上限は大きすぎた・Ken Burns で更に拡大して見える。2026-06-27)。
  // fit幅は Ken Burns 最大ズーム時 (中央基準+8%≈左右40px侵食) でも切れない 840 に (2026-07-10)。
  const fit = fitCaption(captionText, 840, boxH - 80, [56, 50, 46, 42, 38, 34]);
  const totalH = fit.lines.length * fit.lineHeight;
  const capStartY = boxY + (boxH - totalH) / 2 + fit.fontSize;
  let capSvg = "";
  let wordCursor = 0;
  fit.lines.forEach((line, i) => {
    const body = highlightIdx >= 0
      ? karaokeLine(line, wordCursor, highlightIdx, accent)
      : emphasizeNumbers(line, accent);
    wordCursor += line.split(/\s+/).filter(Boolean).length;
    capSvg += `\n  <text x="540" y="${capStartY + i * fit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="900"
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0"${clampAttr(line, fit.fontSize, 840, 0)}>${body}</text>`;
  });
  const accentBar = `<rect x="${boxX}" y="${boxY}" width="14" height="${boxH}" fill="${accent}" rx="7"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="darken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0A0A0A" stop-opacity="0.92"/>
      <stop offset="22%" stop-color="#0A0A0A" stop-opacity="0.50"/>
      <stop offset="68%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <image href="_assets/${bgFile}" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#darken)"/>

  <!-- Top: yellow stripe + country (no flag) -->
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>
  <text x="60" y="160" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#F5E63B" letter-spacing="6"${cnClamp}>${escape(cnText)}</text>
  ${headlineSvg}

  <!-- Caption box -->
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#0A0A0A" fill-opacity="0.82" rx="20"/>
  ${accentBar}
  ${capSvg}

  ${sourceFooter(story)}
</svg>`;
}

/**
 * Word card scene. cue text changes between "Today's English word from this story is X"
 *   / "X means: ..." / "You will hear this word in world news...".
 * We show the big word always and add the cue text below.
 */
function wordSvg(keyword: Keyword | undefined, cueText: string, cueIdx: number, story: Story): string {
  const word = keyword?.word ?? "word";
  // Keyword 大字は単語長で動的サイズ
  const kwFontSize = fitKeywordFontSize(word, 900, 220);

  // Caption box (Y 1140-1740) に一字一句収まる font-size を計算
  const boxX = 40, boxY = 1140, boxW = 1000, boxH = 600;
  const fit = fitCaption(cueText, boxW - 80, boxH - 80,
                         [56, 50, 46, 42, 38, 34, 30, 28]);
  const totalH = fit.lines.length * fit.lineHeight;
  const capStartY = boxY + (boxH - totalH) / 2 + fit.fontSize;
  let capSvg = "";
  fit.lines.forEach((line, i) => {
    capSvg += `\n  <text x="540" y="${capStartY + i * fit.lineHeight}" text-anchor="middle"
        font-family="Hiragino Sans" font-weight="700"
        font-size="${fit.fontSize}" fill="#FFFFFF" letter-spacing="0"${clampAttr(line, fit.fontSize, boxW - 80, 0)}>${escape(line)}</text>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0F1B3D"/>

  <!-- Top label band -->
  <rect x="60" y="200" width="960" height="80" fill="#F5E63B"/>
  <text x="540" y="260" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="38" fill="#0A0A0A" letter-spacing="6"${clampAttr("TODAY'S ENGLISH KEYWORD", 38, 900, 6)}>TODAY'S ENGLISH KEYWORD</text>

  <!-- Big keyword (dynamic font-size to avoid overflow) -->
  <text x="540" y="640" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${kwFontSize}" fill="#F5E63B" letter-spacing="-2"${clampAttr(word, kwFontSize, 960, -2)}>${escape(word)}</text>

  <!-- Divider -->
  <rect x="290" y="740" width="500" height="8" fill="#F5E63B"/>

  <!-- Section tag -->
  <text x="540" y="870" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="44" fill="#9CA3AF" letter-spacing="8">${cueIdx === 0 ? "LISTEN" : cueIdx === 1 ? "MEANING" : "USE IT"}</text>

  <!-- Caption box (Y 1140-1740) -->
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#0A0A0A" fill-opacity="0.45" rx="20"/>
  ${capSvg}

  <!-- Brand footer just above source footer -->
  <text x="540" y="1780" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="26" fill="#7A8AB5" letter-spacing="3">DAILY WORLD 60 · @60dailyworld</text>

  ${sourceFooter(story)}
</svg>`;
}

/**
 * @deprecated 未使用 (2026-06-20 以降、末尾はループ用 hookSvg に置換)。
 * 末尾の登録カードはデッドエンド=リテンションを削ぐため呼び出さない。回帰防止のため残置のみ。
 */
function subscribeOutroSvg(story: Story): string {
  const code = story.country.code.toLowerCase();
  const plFs = fitSingleLine("PLEASE", 760, 110);
  const subFs = fitSingleLine("SUBSCRIBE", 1000, 156);
  const handle = "@60dailyworld";
  const hFs = fitSingleLine(handle, 760, 44);
  const yPlease = 760;
  const ySub = yPlease + Math.round(subFs * 1.02);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="subDarken" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0A0A0A" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#0A0A0A" stop-opacity="0.78"/>
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <image href="_assets/bg-${code}-s${story.index}-1.jpg" x="0" y="0" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice"/>
  <rect width="${W}" height="${H}" fill="url(#subDarken)"/>
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>

  <text x="540" y="${yPlease}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${plFs}" fill="#FFFFFF" letter-spacing="4"${clampAttr("PLEASE", plFs, 1000, 4)}>PLEASE</text>
  <text x="540" y="${ySub}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${subFs}" fill="#F5E63B" letter-spacing="2"${clampAttr("SUBSCRIBE", subFs, 1000, 2)}>SUBSCRIBE</text>
  <rect x="340" y="${ySub + 50}" width="400" height="10" fill="#F5E63B"/>
  <text x="540" y="${ySub + 170}" text-anchor="middle" font-family="Hiragino Sans" font-weight="900"
        font-size="${hFs}" fill="#FFFFFF" letter-spacing="3"${clampAttr(handle, hFs, 1000, 3)}>${escape(handle)}</text>
  <text x="540" y="${ySub + 240}" text-anchor="middle" font-family="Hiragino Sans" font-weight="600"
        font-size="30" fill="#9CA3AF" letter-spacing="6">DAILY WORLD 60</text>

  ${sourceFooter(story)}
</svg>`;
}

// ─────────── Helpers ───────────

/**
 * 1シーン (静止PNG → クリップ) の映像フィルタ。
 * MOTION 有効時は Ken Burns (中央ズーム) を全シーンに付与し、index 偶奇で push-in / pull-out を交互に。
 * パン (x/y移動) は単画像でジッタが出やすいので中央ズームのみ採用 (低リスク・確実に動く)。
 * 元画像を 2x に上げてからズーム後に WxH へ落とす = サブピクセル移動を吸収して滑らかに。
 * MOTION=off で従来の静止 (scale のみ) に即フォールバック。
 */
function sceneVf(durSec: number, idx: number, isStatic = false): string {
  if (!MOTION || isStatic) return `scale=${W}:${H},format=yuv420p`;
  const frames = Math.max(2, Math.round(durSec * FPS));
  const df = Math.max(1, frames - 1);
  const zMax = (1 + KB_ZOOM).toFixed(4);
  const zExpr = idx % 2 === 0
    ? `1.0+${KB_ZOOM}*on/${df}`       // push-in (0 → +zoom)
    : `${zMax}-${KB_ZOOM}*on/${df}`;  // pull-out (+zoom → 0)
  return [
    `scale=${2 * W}:${2 * H}`,
    `zoompan=z='${zExpr}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${FPS}:s=${W}x${H}`,
    `format=yuv420p`,
  ].join(",");
}

/** 地図シーン: 焦点 (fx,fy)[フレーム比] へズームイン (1.0→1.35)。中央でなく国の位置へ寄る。 */
function mapVf(durSec: number, fx: number, fy: number): string {
  if (!MOTION) return `scale=${W}:${H},format=yuv420p`;
  const frames = Math.max(2, Math.round(durSec * FPS));
  const df = Math.max(1, frames - 1);
  const z = `1.0+0.35*on/${df}`;
  const cx = `(${fx.toFixed(4)}*iw)`;
  const cy = `(${fy.toFixed(4)}*ih)`;
  return [
    `scale=${2 * W}:${2 * H}`,
    `zoompan=z='${z}':d=1:x='max(0,min(iw-iw/zoom,${cx}-(iw/zoom/2)))':y='max(0,min(ih-ih/zoom,${cy}-(ih/zoom/2)))':fps=${FPS}:s=${W}x${H}`,
    `format=yuv420p`,
  ].join(",");
}

/** ビート画像の連続ズーム (中央)。zStart→zEnd を線形に。cue 内チャンクで継ぎ目なく寄るために使う。 */
function kbVf(durSec: number, zStart: number, zEnd: number): string {
  if (!MOTION) return `scale=${W}:${H},format=yuv420p`;
  const frames = Math.max(2, Math.round(durSec * FPS));
  const df = Math.max(1, frames - 1);
  const z = `${zStart.toFixed(4)}+(${(zEnd - zStart).toFixed(4)})*on/${df}`;
  return [
    `scale=${2 * W}:${2 * H}`,
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${FPS}:s=${W}x${H}`,
    `format=yuv420p`,
  ].join(",");
}

/** 動くドット世界地図シーン (米国ニュース風・国へズーム)。{svg, fx, fy} を返す (fx/fy=マーカーのフレーム比)。 */
function mapSvg(story: Story, lonlat: [number, number]): { svg: string; fx: number; fy: number } {
  const scale = W / MAP_W;          // 0.75
  const mapY0 = 660;                // 地図バンド上端
  const [mlon, mlat] = lonlat;
  const [mxRaw, myRaw] = lonLatToXY(mlon, mlat);
  const fxPx = mxRaw * scale;
  const fyPx = mapY0 + myRaw * scale;
  const fx = fxPx / W, fy = fyPx / H;

  const cn = (story.country.name ?? story.country.code).toUpperCase();
  const cnFs = fitSingleLine(cn, 960, 116);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <radialGradient id="mapbg" cx="50%" cy="42%" r="80%">
      <stop offset="0%" stop-color="#0F1B3D"/>
      <stop offset="100%" stop-color="#020617"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#mapbg)"/>
  <rect x="0" y="0" width="${W}" height="60" fill="#F5E63B"/>

  <text x="60" y="360" font-family="Hiragino Sans" font-weight="900"
        font-size="42" fill="#F5E63B" letter-spacing="6">WHERE IT'S HAPPENING</text>
  <text x="60" y="476" font-family="Hiragino Sans" font-weight="900"
        font-size="${cnFs}" fill="#FFFFFF" letter-spacing="-2"${clampAttr(cn, cnFs, 960, -2)}>${escape(cn)}</text>

  <g transform="translate(0 ${mapY0}) scale(${scale})">
    ${worldDots(3, 3.6, "#5B7290", 0.9)}
  </g>

  <!-- marker (国の位置) -->
  <circle cx="${fxPx.toFixed(1)}" cy="${fyPx.toFixed(1)}" r="50" fill="none" stroke="#F5E63B" stroke-width="4" opacity="0.5"/>
  <circle cx="${fxPx.toFixed(1)}" cy="${fyPx.toFixed(1)}" r="28" fill="none" stroke="#F5E63B" stroke-width="6" opacity="0.85"/>
  <circle cx="${fxPx.toFixed(1)}" cy="${fyPx.toFixed(1)}" r="12" fill="#F5E63B"/>

  ${sourceFooter(story)}
</svg>`;
  return { svg, fx, fy };
}

async function parseVtt(p: string): Promise<VttCue[]> {
  const text = await fs.readFile(p, "utf-8");
  const cues: VttCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (m) {
      const start = toSec(m[1], m[2], m[3], m[4]);
      const end = toSec(m[5], m[6], m[7], m[8]);
      let txt = "";
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) txt += lines[j] + " ";
      cues.push({ start, end, text: txt.trim() });
    }
  }
  return cues;
}
function toSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}
function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    proc.stdout.on("data", chunk => (out += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n) || n <= 0) return reject(new Error(`bad duration: ${out}`));
      resolve(n);
    });
  });
}
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
