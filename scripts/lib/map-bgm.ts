import { spawn } from "node:child_process";
import { isConflictStory, pickBgm, type BgmPick } from "./bgm-select.js";

/**
 * 地図ショートの BGM (2026-11-08 オーナー指示「BGMもつけてください」)。
 * 曲のプール・回し方・声の下で BGM を下げる設定・-14 LUFS は本編 (remotion/render-shorts.mjs) と同じ。
 * 曲は Kevin MacLeod / CC BY 4.0 なので、使った曲は必ず説明欄に帰属表示する (bgm-credit.ts)。
 */

const BGM_VOLUME = Number(process.env.BGM_VOLUME ?? "0.25");
const FADE_IN_SEC = 1.2;
const FADE_OUT_SEC = 1.4;
// prep-map は読み上げを -14 LUFS にそろえてある。本編は Kokoro の素の音量 (約 -27 LUFS) のまま BGM と混ぜるので、
// 声と BGM の釣り合いを本編と同じにするため声を 13 dB 下げてから混ぜる (最後の loudnorm で -14 に戻る)。
// 下げないと BGM は声より約 22 dB 下でほぼ聞こえない (本編は 7〜9 dB 下)
const VOICE_PRE_GAIN_DB = -13;

export type MapBgm = BgmPick & { volume: number };

type MapRef = { id: string; title: string; shortTitle: string };
const isConflictMap = (m: MapRef) => isConflictStory({ headline: m.title, hookText: m.shortTitle });

/**
 * 曲は同じプールの地図の中での登録順で回す (続けて投稿する地図が同じ曲にならない。同じ曲の使い回しは YouTube のスパム例に名指しされている)。
 * 軍事などの地図は重い曲のプールから。曲の中の開始位置は日付で変わる。
 */
export async function pickMapBgm(date: string, map: MapRef, registry: MapRef[]): Promise<MapBgm | null> {
  const conflict = isConflictMap(map);
  const slot = registry.filter(m => isConflictMap(m) === conflict).findIndex(m => m.id === map.id);
  const picked = await pickBgm(date, map.id, 1, conflict, Math.max(0, slot));
  return picked ? { ...picked, volume: BGM_VOLUME } : null;
}

/** 書き出した動画に BGM を重ねる ffmpeg の引数。声が無い (無音の地図) ときは BGM だけを入れる */
export function bgmMixArgs(raw: string, final: string, bgm: MapBgm, durationSec: number, hasVoice: boolean): string[] {
  const fadeOut = Math.max(0.1, durationSec - FADE_OUT_SEC);
  const bed = `[1:a]volume=${bgm.volume},afade=t=in:st=0:d=${FADE_IN_SEC},afade=t=out:st=${fadeOut.toFixed(2)}:d=${FADE_OUT_SEC}`;
  const chain = hasVoice
    ? `${bed}[bg];[0:a]volume=${VOICE_PRE_GAIN_DB}dB,asplit=2[voice][key];` +
      `[bg][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[duck];` +
      `[voice][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`
    // BGM だけだと loudnorm を通してもピークが 0 dB を超える曲がある (Rising Tide で +0.2 dBTP)。最後に約 -3 dB で頭を抑える
    : `${bed},loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.7:level=disabled[a]`;
  return [
    "-y", "-v", "error", "-i", raw,
    "-stream_loop", "-1", "-ss", String(bgm.offset), "-i", bgm.file,
    "-filter_complex", chain, "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", durationSec.toFixed(3), final,
  ];
}

export function mixBgm(raw: string, final: string, bgm: MapBgm, durationSec: number, hasVoice: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", bgmMixArgs(raw, final, bgm, durationSec, hasVoice), { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", c => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
  });
}
