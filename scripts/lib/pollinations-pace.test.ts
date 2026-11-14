import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacer, OverBudget, RateLimited, retryWaitMs, storyBudgetMs } from "./pollinations-pace.js";

const GAP = 46_000;
const BUDGET = 660_000;

// 実際には待たない時計。待っている処理のうち、いちばん早く起きるものから順に時刻を進める
function virtualTime() {
  let now = 0;
  const timers: Array<{ at: number; wake: () => void }> = [];
  const io = {
    now: () => now,
    sleep: (ms: number) => new Promise<void>(wake => { timers.push({ at: now + ms, wake }); }),
  };
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const watched = p.finally(() => { done = true; });
    watched.catch(() => {});
    for (;;) {
      await new Promise(r => setImmediate(r));
      if (done) return watched;
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift();
      if (!t) throw new Error("待ちが無いのに終わらない");
      now = Math.max(now, t.at);
      t.wake();
    }
  }
  return { io, settle };
}

// 相手の決まり (2026-11-10 実測): 通った依頼の開始から45秒は 402 と retry-after を返す。断った依頼では延びない
function freeTier(io: { now: () => number; sleep: (ms: number) => Promise<void> }, tookMs = 10_000) {
  const starts: number[] = [];
  let openAt = 0;
  const request = async () => {
    const at = io.now();
    starts.push(at);
    if (at < openAt) {
      await io.sleep(400);
      throw new RateLimited(402, String(Math.ceil((openAt - io.now()) / 1000)));
    }
    openAt = at + 45_000;
    await io.sleep(tookMs);
  };
  return { starts, request, occupy: (at: number) => { openAt = at + 45_000; } };
}

test("続けて頼んでも相手の制限に当たらない。2枚目からは前の依頼の開始から46秒後に頼む", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const server = freeTier(io);
  await settle((async () => { for (let i = 0; i < 13; i++) await pacer.run(server.request); })());
  assert.deepEqual(server.starts, Array.from({ length: 13 }, (_, i) => i * GAP));
  assert.deepEqual(pacer.stats.rejected, []);
  assert.equal(pacer.stats.waitMs, 12 * (GAP - 10_000));
  assert.equal(io.now(), 12 * GAP + 10_000);
});

test("402 は retry-after に1秒足して待ってから通る。断られた依頼を数え始めにして先へ延ばさない", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const server = freeTier(io);
  // 同じ IP のほかの利用者が10秒前に1枚頼んでいた
  server.occupy(-10_000);
  await settle(pacer.run(server.request));
  // 1回目は 0秒で 402 (retry-after 35)。0.4秒後の返事から 36秒待って 36.4秒に頼み直す
  assert.deepEqual(server.starts, [0, 36_400]);
  assert.deepEqual(pacer.stats.rejected, [402]);
  await settle(pacer.run(server.request));
  assert.equal(server.starts[2], 36_400 + GAP);
});

test("retry-after が無い・読めないときは間隔ぶん待つ。1回の待ちは90秒まで", () => {
  assert.equal(retryWaitMs("36", GAP), 37_000);
  assert.equal(retryWaitMs("0", GAP), 1_000);
  assert.equal(retryWaitMs(null, GAP), GAP);
  assert.equal(retryWaitMs("", GAP), GAP);
  assert.equal(retryWaitMs("Wed, 21 Oct 2026 07:28:00 GMT", GAP), GAP);
  assert.equal(retryWaitMs("-5", GAP), GAP);
  assert.equal(retryWaitMs("3600", GAP), 90_000);
  assert.equal(retryWaitMs(null, 120_000), 90_000);
});

test("1枚につき3回まで。3回とも断られたらその絵はあきらめ、次の絵も相手の言う時刻まで待つ", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const starts: number[] = [];
  const refused = async () => { starts.push(io.now()); throw new RateLimited(429, "20"); };
  await assert.rejects(settle(pacer.run(refused)), /pollinations HTTP 429/);
  assert.deepEqual(starts, [0, 21_000, 42_000]);
  assert.deepEqual(pacer.stats.rejected, [429, 429, 429]);
  const next = async () => { starts.push(io.now()); };
  await settle(pacer.run(next));
  assert.equal(starts[3], 63_000);
});

test("retry-after の無い 402 は間隔ぶん待ってやり直す", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const starts: number[] = [];
  let n = 0;
  await settle(pacer.run(async () => {
    starts.push(io.now());
    await io.sleep(500);
    if (n++ === 0) throw new RateLimited(402, null);
  }));
  assert.deepEqual(starts, [0, 500 + GAP]);
});

test("5xx や通信の失敗も3回まで。やり直しは間隔を守り、返事が遅ければ今までどおり6秒・14秒は空ける", async () => {
  const quick = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, quick.io);
  const starts: number[] = [];
  let n = 0;
  await quick.settle(pacer.run(async () => {
    starts.push(quick.io.now());
    await quick.io.sleep(2_000);
    if (n++ === 0) throw new Error("pollinations HTTP 503");
  }));
  assert.deepEqual(starts, [0, GAP]);
  assert.deepEqual(pacer.stats.rejected, []);

  const slow = virtualTime();
  const pacer2 = createPacer({ gapMs: GAP, budgetMs: BUDGET }, slow.io);
  const starts2: number[] = [];
  const timeout = async () => {
    starts2.push(slow.io.now());
    await slow.io.sleep(45_000);
    throw new Error("The operation was aborted due to timeout");
  };
  await assert.rejects(slow.settle(pacer2.run(timeout)), /timeout/);
  // 45秒で失敗 → 6秒空けて 51秒。96秒で失敗 → 14秒空けて 110秒
  assert.deepEqual(starts2, [0, 51_000, 110_000]);
});

test("締め切りを過ぎたら頼まない。待つと締め切りを越えるときは、待たずに打ち切る", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: 100_000 }, io);
  const server = freeTier(io);
  const results: string[] = [];
  await settle((async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await pacer.run(server.request);
        results.push("ok");
      } catch (e) {
        results.push(e instanceof OverBudget ? "over" : "error");
      }
    }
  })());
  // 0・46・92秒は頼める。4枚目は 138秒になるので、102秒の時点で待たずにやめる
  assert.deepEqual(server.starts, [0, GAP, 2 * GAP]);
  assert.deepEqual(results, ["ok", "ok", "ok", "over", "over"]);
  assert.equal(io.now(), 2 * GAP + 10_000);
});

test("やり直しの待ちが締め切りを越えるときも、待たずに打ち切る", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: 60_000 }, io);
  const starts: number[] = [];
  const refused = async () => { starts.push(io.now()); throw new RateLimited(402, "80"); };
  await assert.rejects(settle(pacer.run(refused)), OverBudget);
  assert.deepEqual(starts, [0]);
  assert.equal(io.now(), 0);
});

test("前の依頼が長引いて締め切りを過ぎたら、次は頼まない", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: 50_000 }, io);
  const starts: number[] = [];
  await settle(pacer.run(async () => { starts.push(io.now()); await io.sleep(60_000); }));
  await assert.rejects(settle(pacer.run(async () => { starts.push(io.now()); })), OverBudget);
  assert.deepEqual(starts, [0]);
});

test("本ごとの締め切りを渡すと、その本はそこで打ち切り、次の本は続きから頼める", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const server = freeTier(io);
  await settle((async () => {
    await pacer.run(server.request, 50_000);
    await pacer.run(server.request, 50_000);
    await assert.rejects(pacer.run(server.request, 50_000), OverBudget);
    await pacer.run(server.request, BUDGET);
  })());
  assert.deepEqual(server.starts, [0, GAP, 2 * GAP]);
});

test("並べて頼んでも (BEAT_CONCURRENCY=2)、依頼の開始は46秒ずつ離れる", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const server = freeTier(io, 30_000);
  let next = 0;
  const worker = async () => { while (next < 6) { next++; await pacer.run(server.request); } };
  await settle(Promise.all([worker(), worker()]));
  assert.deepEqual(server.starts, Array.from({ length: 6 }, (_, i) => i * GAP));
  assert.deepEqual(pacer.stats.rejected, []);
});

test("並べて頼んでいる途中で 402 が出ても、次の依頼を相手の言う時刻より前に出さない", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const server = freeTier(io, 30_000);
  server.occupy(-20_000);
  let next = 0;
  const worker = async () => { while (next < 4) { next++; await pacer.run(server.request); } };
  await settle(Promise.all([worker(), worker()]));
  // 0秒は 402 (retry-after 25)。そのあとは通った依頼どうしが46秒以上離れる
  assert.equal(server.starts[0], 0);
  assert.deepEqual(pacer.stats.rejected, [402]);
  const passed = server.starts.slice(1);
  assert.equal(passed.length, 4);
  assert.ok(passed[0] >= 25_000);
  for (let i = 1; i < passed.length; i++) assert.ok(passed[i] - passed[i - 1] >= GAP, `${passed[i - 1]} → ${passed[i]}`);
});

test("402 の返事が遅れて届いても、そのあとに頼んだ依頼との間隔は縮めない", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const starts: number[] = [];
  let n = 0;
  const slowRefusal = async () => {
    starts.push(io.now());
    if (n++ === 0) {
      await io.sleep(50_000);
      throw new RateLimited(402, "0");
    }
    await io.sleep(10_000);
  };
  const other = async () => { starts.push(io.now()); await io.sleep(10_000); };
  await settle(Promise.all([pacer.run(slowRefusal), pacer.run(other)]));
  // 0秒の依頼が50秒後に断られた時点で、46秒に別の依頼がもう出ている。頼み直しは 51秒ではなく 92秒
  assert.deepEqual(starts, [0, GAP, 2 * GAP]);
});

test("本ごとの締め切り: 後ろの本に冒頭と本文1枚ぶん (2枠) を残す。最後の本は絵の段の締め切りまで", () => {
  assert.equal(storyBudgetMs(BUDGET, GAP, 0, 3), BUDGET - 4 * GAP);
  assert.equal(storyBudgetMs(BUDGET, GAP, 1, 3), BUDGET - 2 * GAP);
  assert.equal(storyBudgetMs(BUDGET, GAP, 2, 3), BUDGET);
  assert.equal(storyBudgetMs(BUDGET, GAP, 0, 1), BUDGET);
  // 締め切りを短くした日も、前の本の持ち時間が等分より短くはならない
  assert.equal(storyBudgetMs(120_000, GAP, 0, 3), 40_000);
  assert.equal(storyBudgetMs(120_000, GAP, 1, 3), 80_000);
  assert.equal(storyBudgetMs(0, GAP, 0, 3), 0);
});

test("相手が断り続ける日でも、3本目に冒頭と本文1枚を頼む時間が残る", async () => {
  const { io, settle } = virtualTime();
  const pacer = createPacer({ gapMs: GAP, budgetMs: BUDGET }, io);
  const asked: number[][] = [[], [], []];
  await settle((async () => {
    for (let s = 0; s < 3; s++) {
      const budget = storyBudgetMs(BUDGET, GAP, s, 3);
      for (let img = 0; img < 5; img++) {
        const refused = async () => { asked[s].push(io.now()); throw new RateLimited(402, "89"); };
        await pacer.run(refused, budget).catch(() => {});
      }
    }
  })());
  assert.ok(asked[0].length > 0 && asked[1].length > 0 && asked[2].length > 0, JSON.stringify(asked));
  assert.ok(asked[2][0] <= BUDGET - 2 * GAP + 90_000, JSON.stringify(asked));
  assert.ok(Math.max(...asked.flat()) <= BUDGET);
});

test("既定の時計と待ち (差し替えなし) でも、依頼の開始が間隔ぶん離れる", async () => {
  const pacer = createPacer({ gapMs: 60, budgetMs: 5_000 });
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) await pacer.run(async () => { starts.push(Date.now()); });
  assert.ok(starts[1] - starts[0] >= 55, `${starts[1] - starts[0]}ms`);
  assert.ok(starts[2] - starts[1] >= 55, `${starts[2] - starts[1]}ms`);
  assert.ok(pacer.stats.waitMs >= 100, `${pacer.stats.waitMs}ms`);
});
