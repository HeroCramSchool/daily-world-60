/**
 * Claude API の費用を呼び出しごとに数え、1 回の実行の上限で止める。
 * 本ごとの予算は呼ぶ側（write-explainers）が最初にまとめて押さえ（openStory）、本の中の呼び出しはその予算から押さえる。
 * 予算を持たない本の呼び出しは、上限の残りから押さえる。
 * 料金は 2026-11-01 時点の Claude Opus 5.5（$/token）。
 */
export const PRICES = {
  input: 4e-6,
  output: 20e-6,
  cacheWrite: 5e-6,
  cacheRead: 0.2e-6,
  webSearch: 0.01,
} as const;

export type Step = "research" | "write" | "refute";

/**
 * 呼ぶ前に押さえておく見込み額。失敗した呼び出しは実額が分からないので、この額を estimated として数える。
 * 実測ではない。初回の本番の claude-usage.json の実額（多めの値）で決め直す。CostMeter の reserve で差し替えられる。
 */
export const RESERVE: Record<Step, number> = { research: 0.5, write: 0.15, refute: 0.15 };

type TokenCounts = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export type UsageLike = TokenCounts & {
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
  iterations?: Array<TokenCounts & { type: string; model?: string | null }> | null;
};

/** estimated: 失敗・中断した呼び出し。usage は分からないので空、costUsd は見込み額。 */
export type CallRecord = { story: number; step: Step; model: string; usage: UsageLike; costUsd: number; estimated?: true };

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const tokenCost = (u: TokenCounts) =>
  n(u.input_tokens) * PRICES.input + n(u.output_tokens) * PRICES.output +
  n(u.cache_creation_input_tokens) * PRICES.cacheWrite + n(u.cache_read_input_tokens) * PRICES.cacheRead;

/**
 * 1 回の呼び出しの額。拒否されて別のモデルが答えたときは、上の usage は答えたモデルの分だけなので、
 * 断ったモデルの iterations も足す（多めに数える側に倒す）。
 * 断ったモデル・代わりのモデルのトークンも Opus 5.5 の単価で近似する。
 */
export function costOf(usage: UsageLike, servedModel?: string): number {
  let cost = tokenCost(usage) + n(usage.server_tool_use?.web_search_requests) * PRICES.webSearch;
  const its = usage.iterations ?? [];
  if (its.some(it => it.type === "fallback_message")) {
    for (const it of its) if (it.type === "message" && it.model !== servedModel) cost += tokenCost(it);
  }
  return cost;
}

export type Hold = { readonly step: Step; readonly story: number; readonly amount: number; open: boolean };

type Budget = { readonly amount: number; spent: number; held: number };

const EPS = 1e-9;

export class CostMeter {
  private spentUsd = 0;
  private looseSpentUsd = 0;
  private looseHeldUsd = 0;
  private readonly budgets = new Map<number, Budget>();
  private readonly log: CallRecord[] = [];
  private readonly reserves: Record<Step, number>;

  constructor(readonly capUsd: number, opts: { reserve?: Partial<Record<Step, number>> } = {}) {
    this.reserves = { ...RESERVE, ...opts.reserve };
  }

  /** 上限のうち塞がっている額。本の予算は、使った額が予算を超えたらその額で数える。 */
  private committed(): number {
    let sum = this.looseSpentUsd + this.looseHeldUsd;
    for (const b of this.budgets.values()) sum += Math.max(b.amount, b.spent + b.held);
    return sum;
  }

  /** その本の予算をまとめて押さえる。上限に収まらない・もう押さえてあるなら false。 */
  openStory(story: number, amountUsd: number): boolean {
    if (this.budgets.has(story) || this.committed() + amountUsd > this.capUsd + EPS) return false;
    this.budgets.set(story, { amount: amountUsd, spent: 0, held: 0 });
    return true;
  }

  storyBudget(story: number): number | undefined {
    return this.budgets.get(story)?.amount;
  }

  /** 見込み額を押さえる。本の予算（無ければ上限の残り）に収まらないなら null（呼ばない）。 */
  reserve(step: Step, story: number): Hold | null {
    const amount = this.reserves[step];
    const b = this.budgets.get(story);
    if (b) {
      if (b.spent + b.held + amount > b.amount + EPS) return null;
      b.held += amount;
    } else {
      if (this.committed() + amount > this.capUsd + EPS) return null;
      this.looseHeldUsd += amount;
    }
    return { step, story, amount, open: true };
  }

  release(hold: Hold): void {
    if (!hold.open) return;
    hold.open = false;
    const b = this.budgets.get(hold.story);
    if (b) b.held -= hold.amount;
    else this.looseHeldUsd -= hold.amount;
  }

  record(hold: Hold, model: string, usage: UsageLike): number {
    this.release(hold);
    return this.add({ story: hold.story, step: hold.step, model, usage, costUsd: costOf(usage, model) });
  }

  /** 失敗・中断した呼び出しも途中まで課金されうるので、$0 にせず見込み額を estimated として数える。 */
  recordEstimate(hold: Hold, model: string): number {
    if (!hold.open) return 0;
    this.release(hold);
    return this.add({ story: hold.story, step: hold.step, model, usage: {}, costUsd: hold.amount, estimated: true });
  }

  private add(c: CallRecord): number {
    this.spentUsd += c.costUsd;
    const b = this.budgets.get(c.story);
    if (b) b.spent += c.costUsd;
    else this.looseSpentUsd += c.costUsd;
    this.log.push(c);
    return c.costUsd;
  }

  get spent(): number {
    return this.spentUsd;
  }

  storyCost(story: number): number {
    return this.log.filter(c => c.story === story).reduce((a, c) => a + c.costUsd, 0);
  }

  /** その本で答えが返ってきた呼び出しの数（estimated は数えない）。 */
  completedCalls(story: number): number {
    return this.log.filter(c => c.story === story && !c.estimated).length;
  }

  calls(): CallRecord[] {
    return [...this.log];
  }
}
