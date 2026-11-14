/**
 * 今の形式のショートで、AI の絵 (冒頭の絵 hero-… と本文の絵 beat-…-b{n}.jpg) をどの文に当てるかと、
 * 絵が替わる所 (firstOfCue) の決め方。remotion/prep-short.ts が使う。
 */

export type BeatAssignment = {
  /** 冒頭の絵。AI の冒頭の絵が無ければ、番号がいちばん若い本文の絵。どちらも無ければ null */
  hook: string | null;
  /** 本文の文ごとの絵。本文の絵が1枚も無ければ空 (呼び出し側が手持ちの写真に落とす) */
  body: string[];
};
export type ChunkPicture = { bg: string | null; sentenceStart: boolean };

const BEAT_NO_RE = /-b(\d+)\.jpg$/;

/**
 * 本文の絵を、ファイル名の番号 n で n 番目の文に当てる。並び順では詰めない
 * (b1 と b3 が欠けて b2 だけ残った回に、2文目用の絵が冒頭と全部の文に出た。2026-11-10)。
 * 欠けた番号の文は直前の絵を続け、1文目が欠けたら冒頭の絵を使う。
 */
export function assignBeats(beatFiles: string[], sentences: string[], hero: string | null): BeatAssignment {
  const byNo = new Map<number, string>();
  for (const f of beatFiles) {
    const m = BEAT_NO_RE.exec(f);
    if (m) byNo.set(Number(m[1]), f);
  }
  if (!byNo.size) return { hook: hero, body: [] };
  const hook = hero ?? byNo.get(Math.min(...byNo.keys()))!;
  const body: string[] = [];
  let current = hook;
  let n = 0;
  for (const s of sentences) {
    // 番号は fetch-broll.ts の splitBeats と同じ数え方。3語未満のかけらは番号を進めず、直前の絵を続ける
    if (s.trim().split(/\s+/).length >= 3) current = byNo.get(++n) ?? current;
    body.push(current);
  }
  return { hook, body };
}

/**
 * チャンクごとの firstOfCue (効果音と絵のフェードを出す印)。最初のチャンクと、前のチャンクと絵が違うチャンクだけ true。
 * 文の頭でも絵が同じなら false (同じ絵のまま暗転しない)。
 * mapFirst = 最初のチャンクに地図を出す本。その次のチャンクは画面が地図から絵に替わるので、
 * 文の頭なら絵が同じでも true のままにする (文の途中なら false。どちらも直す前と同じ)。
 */
export function pictureStarts(chunks: ChunkPicture[], mapFirst: boolean): boolean[] {
  return chunks.map((c, i) => i === 0 || c.bg !== chunks[i - 1].bg || (mapFirst && i === 1 && c.sentenceStart));
}
