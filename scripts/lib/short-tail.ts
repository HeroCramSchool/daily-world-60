/**
 * 今の形式のショートの終わりの割り方。読み上げ原稿は Script.toStoryNarration の並び
 * (本文 → 締め "And that's the latest from X." → 本ごとの問い → 定型の問い) で、
 * その文の並びから「本文の終わり・締め・問いかけ」を決める。
 */

export type TailSentence = { text: string; start: number; end: number };
export type TailQuestion = TailSentence & { cta?: { text: string; start: number } };
export type ShortTail = {
  /** 本文はこの番号の手前まで */
  bodyEnd: number;
  /** 締めの文の番号。無ければ -1 */
  outroIdx: number;
  question: TailQuestion | null;
};

const OUTRO_RE = /that's the latest/i;
const CTA_RE = /what do you think about this/i;

/** 原稿を文に割る。番号がそろうよう remotion/prep-short.ts の sentenceBounds と同じ切り方にしてある。 */
export function narrationSentences(narration: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return narration.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(s => norm(s));
}

function lastIndex(sentences: TailSentence[], re: RegExp): number {
  for (let i = sentences.length - 1; i >= 0; i--) if (re.test(sentences[i].text)) return i;
  return -1;
}

/**
 * text は原稿の文 (句読点つき)。Kokoro の単語データは句読点を落とすので、単語から組むと「?」が消える。
 * 締めは最後の一致を使う (本文の途中の文が同じ言い回しを含んでも、そこから後ろを問いかけにしない)。
 */
export function shortTail(sentences: TailSentence[]): ShortTail {
  const outroIdx = lastIndex(sentences, OUTRO_RE);
  const ctaIdx = lastIndex(sentences, CTA_RE);
  const from = outroIdx >= 0 ? outroIdx + 1 : ctaIdx;
  const asked = from >= 0 ? sentences.slice(from) : [];
  if (!asked.length) return { bodyEnd: outroIdx >= 0 ? outroIdx : sentences.length, outroIdx, question: null };

  const cta = ctaIdx >= from ? sentences[ctaIdx] : null;
  // 本ごとの問いがあれば定型の文は表示から外す。問いが2文でも (略語で割れた場合も) つないで1つにする
  const own = asked.filter(s => s !== cta);
  return {
    bodyEnd: outroIdx >= 0 ? outroIdx : from,
    outroIdx,
    question: {
      text: (own.length ? own : asked).map(s => s.text).join(" "),
      start: asked[0].start,
      end: asked[asked.length - 1].end,
      ...(cta && own.length ? { cta: { text: cta.text, start: cta.start } } : {}),
    },
  };
}
