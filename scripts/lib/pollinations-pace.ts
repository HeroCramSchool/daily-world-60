/**
 * 無料の Pollinations に絵を頼むときの待ち方 (fetch-broll.ts が使う)。
 * 相手の制限は「1つの IP につき45秒に1枚」(2026-09-29〜)。数え始めは通った依頼の開始で、断られた依頼
 * (402・429) では延びず、返事の retry-after が次に通るまでの秒数を教える (2026-11-10 実測)。
 * 時計と待ちを差し替えられるので、試験は実際に待たない。
 */

export type PaceIo = { now: () => number; sleep: (ms: number) => Promise<void> };

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 90_000;
// 5xx・通信の失敗のあとに最低これだけ空ける (2026-06-28 から同じ値)
const BACKOFF_MS = [6000, 14000];
// 後ろの本1本につき残しておく枠の数 (冒頭の絵と本文の1枚目)
const HELD_PER_STORY = 2;

export class RateLimited extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super(`pollinations HTTP ${status}`);
  }
}

export class OverBudget extends Error {}

/** 402・429 のあとに待つ長さ。retry-after (秒) に1秒足す。無い・読めないときは間隔ぶん。1回の待ちは90秒まで。 */
export function retryWaitMs(retryAfter: string | null, gapMs: number): number {
  const sec = retryAfter === null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
  return Math.min(MAX_WAIT_MS, Number.isFinite(sec) && sec >= 0 ? (sec + 1) * 1000 : gapMs);
}

/**
 * n 本のうち i 本目 (0 始まり) が絵を頼める締め切り (絵の段の始まりからのミリ秒)。
 * 絵は本の順に頼むので、締め切りを1つにすると待ちが延びた日に最後の本だけ絵が0枚になる。
 * 後ろの本1本につき2枠を残し、それでも等分の持ち時間よりは短くしない。
 */
export function storyBudgetMs(budgetMs: number, gapMs: number, i: number, n: number): number {
  return Math.max(budgetMs * (i + 1) / n, budgetMs - (n - 1 - i) * HELD_PER_STORY * gapMs);
}

export function createPacer(
  opts: { gapMs: number; budgetMs: number },
  io: PaceIo = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)) },
) {
  const startedAt = io.now();
  // 次に頼んでよい時刻。冒頭の絵と本文の絵で共有する
  let nextAt = startedAt;
  let turn: Promise<unknown> = Promise.resolve();
  const stats = { waitMs: 0, rejected: [] as number[] };

  // 1つずつ順に通す。並べて呼ばれても (BEAT_CONCURRENCY が2以上でも) 依頼の開始は間隔ぶん離れる
  function enter(deadline: number): Promise<number> {
    const mine = turn.then(async () => {
      const wait = Math.max(0, nextAt - io.now());
      if (io.now() + wait > deadline) {
        throw new OverBudget(`締め切り (絵の段の始まりから${Math.round((deadline - startedAt) / 1000)}秒) を過ぎるので頼まない`);
      }
      if (wait > 0) {
        stats.waitMs += wait;
        await io.sleep(wait);
      }
      nextAt = io.now() + opts.gapMs;
      return nextAt;
    });
    turn = mine.catch(() => {});
    return mine;
  }

  /**
   * task は依頼1回ぶん。頼んでよい時刻まで待ってから呼び、失敗したら1枚につき3回まで頼み直す。
   * RateLimited (402・429) は retry-after を守る。ほかの失敗 (5xx・通信) は間隔を守ったうえで今までどおり間を空ける。
   * 頼む時刻が締め切り (絵の段の始まりから budgetMs) を過ぎるなら、待たずに OverBudget を投げる。
   */
  async function run(task: () => Promise<void>, budgetMs = opts.budgetMs): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const mark = await enter(startedAt + budgetMs);
      try {
        await task();
        return;
      } catch (e) {
        lastErr = e;
        if (e instanceof RateLimited) {
          stats.rejected.push(e.status);
          const until = io.now() + retryWaitMs(e.retryAfter, opts.gapMs);
          // 断られた依頼は相手の数え始めにならない。自分のあとに誰も頼んでいなければ、相手の言う時刻まで戻す
          nextAt = nextAt === mark ? until : Math.max(nextAt, until);
        } else if (attempt < BACKOFF_MS.length) {
          nextAt = Math.max(nextAt, io.now() + BACKOFF_MS[attempt]);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return { run, stats };
}
