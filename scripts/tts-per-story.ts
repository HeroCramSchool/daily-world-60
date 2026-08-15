import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Script } from "../domain/script/Script.js";

/**
 * 各ストーリーごとに個別の voice mp3 + vtt を生成する。
 *
 * 入力:  output/YYYY-MM-DD/script-en.json
 * 出力:  voice-{code}.mp3, voice-{code}.vtt, voice-{code}.words.vtt
 *
 * v2 (2026-07-10): --words-in-cue 1 で単語単位の字幕を取得し (karaoke字幕用の
 * WordBoundary相当)、従来のグループ字幕(voice-{code}.vtt)は単語キューを文末記号で
 * 束ねて自前生成する。失敗時は旧方式(グループ字幕のみ)にフォールバック。
 * レートは TTS_RATE (既定 +5%)。旧 -12% はニュースのテンポとして遅すぎた。
 */

interface Country { code: string; flag: string; name?: string; }
interface Keyword { word: string; definitionEn: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  keyword?: Keyword;
  commentQuestion?: string;
}
interface ScriptJson {
  date: string;
  stories: Story[];
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
}

interface Cue { start: number; end: number; text: string; }

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  // TTS_ENGINE=kokoro (既定・2026-07-23): Kokoro-82M を自前実行 (無料・Apache-2.0・
  // 単語タイムスタンプ native)。edge-tts より自然で、非公式 MS エンドポイント依存も外れる。
  // TTS_ENGINE=edge で従来の edge-tts に戻せる。整合失敗時のフォールバックは常に edge-tts。
  const engine = (process.env.TTS_ENGINE ?? "kokoro").toLowerCase();
  // Kokoro voice: am_michael/am_onyx/am_fenrir 等(米男)・bm_george 等(英男)。KOKORO_VOICE で変更。
  const kokoroVoice = process.env.KOKORO_VOICE ?? "am_michael";
  // AndrewMultilingual = edge-tts で最も自然なプロソディの報道向き男性voice。edge時 + フォールバック時に使用。
  const voice = process.env.EN_VOICE ?? "en-US-AndrewMultilingualNeural";
  // -5% ≈ 128-135 WPM: ESL理解は150WPM超で低下 (Griffiths)・BBC字幕基準160-180WPMの下側。
  // +5%は「速すぎて見にくい」実フィードバックで撤回 (2026-07-10)。
  const rate = process.env.TTS_RATE ?? "-5%";

  for (const story of script.stories) {
    const code = story.country.code.toLowerCase();
    const mp3 = path.join(dir, `voice-${code}.mp3`);
    const vtt = path.join(dir, `voice-${code}.vtt`);
    const wordsVtt = path.join(dir, `voice-${code}.words.vtt`);

    const narration = Script.toStoryNarration(story);
    const engineLabel = engine === "kokoro" ? `kokoro:${kokoroVoice}` : `edge:${voice}`;
    console.log(`[tts] ${code}: ${narration.split(/\s+/).length} words (${engineLabel}, rate ${rate})`);

    // 単語単位字幕つきで一発生成 (audio と word timing が同一runで一致)。
    // kokoro: tts-kokoro.py (native token timestamps) / edge: tts-words.py (WordBoundary)。
    // kokoro が丸ごと失敗 (依存/モデル取得エラー等) したら edge にエンジン降格 (本数ゼロ防止)。
    const textFile = path.join(dir, `_narration-${code}.txt`);
    await fs.writeFile(textFile, narration, "utf-8");
    try {
      if (engine === "kokoro") {
        await run("python3", [path.join("scripts", "tts-kokoro.py"), kokoroVoice, rate, textFile, mp3, wordsVtt]);
      } else {
        await run("python3", [path.join("scripts", "tts-words.py"), voice, rate, textFile, mp3, wordsVtt]);
      }
    } catch (e) {
      if (engine === "kokoro") {
        console.warn(`[tts] ${code}: kokoro synth failed (${e instanceof Error ? e.message : e}) — falling back to edge-tts`);
        await run("python3", [path.join("scripts", "tts-words.py"), voice, rate, textFile, mp3, wordsVtt]);
      } else {
        throw e;
      }
    } finally {
      await fs.unlink(textFile).catch(() => {});
    }

    // 単語キュー → ナレーション原文との整合で「文単位」にグループ化した従来形式の vtt を自前生成。
    // (edge-tts の WordBoundary は句読点を落とすため、句読点ベースでは文境界が取れない)
    const words = await parseVtt(wordsVtt);
    const grouped = words.length >= 3 ? buildGroupedVtt(words, narration) : null;
    if (grouped) {
      await fs.writeFile(vtt, grouped, "utf-8");
    } else {
      // フォールバック: 旧方式でグループ字幕を直接生成 (karaokeは無効になる)
      console.warn(`[tts] ${code}: word cues unavailable (${words.length}) — falling back to grouped subtitles`);
      await fs.unlink(wordsVtt).catch(() => {});
      await run("edge-tts", [
        "--voice", voice,
        `--rate=${rate}`,
        "--pitch=+0Hz",
        "--text", narration,
        "--write-media", mp3,
        "--write-subtitles", vtt,
      ]);
    }

    const stat = await fs.stat(mp3);
    console.log(`[tts] ${code} → ${mp3} (${(stat.size / 1024).toFixed(0)} KB)`);
  }
}

/** 単語キューをナレーション原文の「文」に整列してグループ化し VTT 文字列にする。
 *  cue.text は原文の文そのまま (句読点つき) = "Here's what's happening." 等のシーン境界
 *  マーカー文が独立キューになり build-news-video の境界regexと互換。
 *  整列は正規化テキストの前方一致 (単語の結合/分割差を吸収)。失敗時は null (呼び出し側で旧方式へ)。 */
function buildGroupedVtt(words: Cue[], narration: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentences = narration.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const groups: Cue[] = [];
  let wi = 0;
  for (const sentence of sentences) {
    const target = norm(sentence);
    if (!target) continue;
    let acc = "";
    const startIdx = wi;
    while (wi < words.length && acc.length < target.length) {
      acc += norm(words[wi].text);
      wi++;
    }
    if (acc !== target) {
      console.warn(`[tts] sentence alignment failed at "${sentence.slice(0, 40)}…" (acc ${acc.length} vs ${target.length})`);
      return null;
    }
    groups.push({ start: words[startIdx].start, end: words[wi - 1].end, text: sentence });
  }
  let out = "WEBVTT\n\n";
  for (const g of groups) {
    out += `${toTs(g.start)} --> ${toTs(g.end)}\n${g.text}\n\n`;
  }
  return out;
}

function toTs(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

async function parseVtt(p: string): Promise<Cue[]> {
  const text = await fs.readFile(p, "utf-8").catch(() => "");
  const cues: Cue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (m) {
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      let txt = "";
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) txt += lines[j] + " ";
      cues.push({ start, end, text: txt.trim() });
    }
  }
  return cues;
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
