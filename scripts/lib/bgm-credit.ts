import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * BGM の CC BY 帰属。曲は全て Kevin MacLeod (incompetech.com) / CC BY 4.0。
 *
 * incompetech は自分の楽曲を Content ID に登録しており、公式ページは
 * 「クレームの原因は帰属の入れ忘れ、または動画内に焼き込んで自動で読み取れないこと」と
 * 明記している (https://incompetech.com/music/royalty-free/youtube-contentid.html)。
 * したがって帰属は概要欄のテキストに入れる必要がある。
 */

/** ファイル名から曲名を引く。プール内はファイル名がそのまま曲名。 */
const LEGACY_TITLES: Record<string, string> = {
  "news-bed.mp3": "Investigations",
  "news-bed-longform.mp3": "Lightless Dawn",
};

export function bgmTitle(file: string): string {
  const base = path.basename(file);
  return LEGACY_TITLES[base] ?? base.replace(/\.(mp3|m4a|wav|ogg)$/i, "");
}

export function bgmCredit(file: string): string[] {
  return [
    `Music: "${bgmTitle(file)}" by Kevin MacLeod (incompetech.com)`,
    "Licensed under Creative Commons: By Attribution 4.0",
    "https://creativecommons.org/licenses/by/4.0/",
  ];
}

const MANIFEST = "bgm-used.json";

/** レンダラーが実際に使った曲を記録する。投稿側が同じ曲を帰属できるようにする。 */
export async function recordBgmUsed(dir: string, code: string, file: string): Promise<void> {
  const p = path.join(dir, MANIFEST);
  const cur: Record<string, string> = await fs.readFile(p, "utf-8")
    .then(t => JSON.parse(t) as Record<string, string>)
    .catch(() => ({}));
  cur[code] = path.basename(file);
  await fs.writeFile(p, JSON.stringify(cur, null, 2), "utf-8");
}

/** 記録が無ければ null (BGM 無しでレンダリングされた回)。 */
export async function readBgmUsed(dir: string, code: string): Promise<string | null> {
  const p = path.join(dir, MANIFEST);
  const cur = await fs.readFile(p, "utf-8").then(t => JSON.parse(t) as Record<string, string>).catch(() => null);
  return cur?.[code] ?? null;
}
