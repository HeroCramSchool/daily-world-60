/**
 * Claude API の費用を呼び出しごとに数え、1 日の上限で止める。上限はその回の全部の本で共有する。
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

/** 呼ぶ前に押さえておく見込み額。実際の額が分かったら差し替える。 */
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

export type CallRecord = { story: number; step: Step; model: string; usage: UsageLike; costUsd: number };

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

export type Hold = { readonly step: Step; readonly amount: number; open: boolean };

export class CostMeter {
  private spentUsd = 0;
  private heldUsd = 0;
  private readonly log: CallRecord[] = [];

  constructor(readonly capUsd: number) {}

  /** 見込み額を押さえる。使った額・押さえ中の額・見込み額の合計が上限を超えるなら null（呼ばない）。 */
  reserve(step: Step): Hold | null {
    const amount = RESERVE[step];
    if (this.spentUsd + this.heldUsd + amount > this.capUsd + 1e-9) return null;
    this.heldUsd += amount;
    return { step, amount, open: true };
  }

  release(hold: Hold): void {
    if (!hold.open) return;
    hold.open = false;
    this.heldUsd -= hold.amount;
  }

  record(hold: Hold, story: number, model: string, usage: UsageLike): number {
    this.release(hold);
    const costUsd = costOf(usage, model);
    this.spentUsd += costUsd;
    this.log.push({ story, step: hold.step, model, usage, costUsd });
    return costUsd;
  }

  get spent(): number {
    return this.spentUsd;
  }

  storyCost(story: number): number {
    return this.log.filter(c => c.story === story).reduce((a, c) => a + c.costUsd, 0);
  }

  calls(): CallRecord[] {
    return [...this.log];
  }
}
