import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * BGM の曲と開始位置を決める。ffmpeg 経路 (build-news-video) と Remotion 経路
 * (remotion/prep-short) の両方がこれを使う。ロジックを2箇所に置くと片方だけ直って
 * 挙動が割れるため集約した。
 *
 * 曲を動画ごとに変えるのは演出ではなくポリシー対策。YouTube のスパムポリシーは
 * AI 量産チャンネルの例として「多くの動画でまったく同じBGM」を名指ししている
 * (assets/bgm/README.md)。
 */

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

// 戦争・戦闘・軍事の回。比喩の war (trade war 等) は除く。
const CONFLICT_RE = new RegExp([
  "\\bmissiles?\\b", "\\bair ?strikes?\\b", "\\bdrone strikes?\\b", "\\bshelling\\b", "\\bartillery\\b",
  "\\bceasefire\\b", "\\binvasions?\\b", "\\binvaded\\b", "\\btroops\\b", "\\bsoldiers?\\b",
  "\\bwarships?\\b", "\\bcombat\\b", "\\bbattlefields?\\b", "\\bfront ?lines?\\b",
  "\\bcasualt(y|ies)\\b", "\\bwounded\\b", "\\bbombing\\b", "\\bairstrikes?\\b",
  "\\boffensives?\\b", "\\binsurgents?\\b", "\\bmilitants?\\b", "\\bmilitia\\b",
  "\\bwar crimes?\\b", "\\bgenocide\\b", "\\bhostages?\\b", "\\bmilitary\\b",
  "\\bMarine Corps\\b", "\\bMedal of Honor\\b", "\\bkilled in action\\b", "\\bbattle of\\b",
  "\\bsieges?\\b", "\\bbesieged\\b", "\\bwar-?torn\\b", "\\bcivil war\\b",
  "\\brebels?\\b", "\\bparamilitary\\b", "\\barmed (group|forces)\\b",
  "\\bdisplaced by\\b", "\\brefugees? fleeing\\b",
].join("|"), "i");
const WAR_RE = /\bwars?\b/i;
const WAR_METAPHOR_RE = /\b(trade|price|culture|bidding|turf|flame|drug|class|talent|streaming|chip|tariff)\s+wars?\b/i;

export function isConflictStory(story: {
  headline?: string; hookText?: string; summary?: string; bgmMood?: string;
}): boolean {
  const mood = (story.bgmMood ?? "").toLowerCase();
  if (mood === "conflict") return true;
  if (mood === "normal") return false;
  const text = `${story.headline ?? ""} ${story.hookText ?? ""} ${story.summary ?? ""}`;
  if (CONFLICT_RE.test(text)) return true;
  return WAR_RE.test(text) && !WAR_METAPHOR_RE.test(text);
}

async function poolFiles(dir: string): Promise<string[]> {
  return fs.readdir(dir)
    .then(f => f.filter(n => /\.(mp3|m4a|wav|ogg)$/i.test(n)).sort())
    .catch(() => [] as string[]);
}

export type BgmPick = { file: string; offset: number; conflict: boolean };

/**
 * conflict=true は重い曲のプール (assets/bgm-conflict) から選ぶ。
 * どちらのプールも空なら assets/news-bed.mp3 に落ちる。
 * 同じ日付・同じ動画なら常に同じ結果 (再レンダリングで音が変わらない)。
 */
export async function pickBgm(
  date: string, code: string, storyIndex: number, conflict = false,
): Promise<BgmPick | null> {
  let file = process.env.BGM_PATH ?? "";
  if (!file) {
    const dir = path.join(ROOT, "assets", conflict ? "bgm-conflict" : "bgm");
    const pool = await poolFiles(dir);
    file = pool.length
      ? path.join(dir, pool[hashStr(`${date}-${code}-${storyIndex}`) % pool.length])
      : path.join(ROOT, "assets", "news-bed.mp3");
  }
  if (!(await fs.access(file).then(() => true).catch(() => false))) return null;

  // 曲の中で開始位置をずらす。末尾20秒は残す (ループの繋ぎを不自然にしない)。
  // 日付でベースを回し story index で等間隔にずらす = 同日の3本が必ず別区間。
  const dur = await ffprobeDuration(file).catch(() => 0);
  const span = Math.max(0, dur - 20);
  if (span <= 1) return { file, offset: 0, conflict };
  const base = hashStr(date) % Math.floor(span);
  const stride = Math.floor(span / 3);
  return { file, offset: (base + (Math.max(1, storyIndex) - 1) * stride) % Math.floor(span), conflict };
}

function ffprobeDuration(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]);
    let o = "";
    proc.stdout.on("data", d => (o += d));
    proc.on("error", reject);
    proc.on("close", c => (c === 0 ? resolve(parseFloat(o.trim())) : reject(new Error(`ffprobe exit ${c}`))));
  });
}
