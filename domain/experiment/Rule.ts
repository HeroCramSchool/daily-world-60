/**
 * 判定の決まりの小さな式（eval を使わない）。
 * 例: "ratio>=1.3 && lo>=0.8" / "ratio<1.0" / "nT>=6 && medT<76.5"
 * 変数: ratio, lo, hi（treatment/control の幾何平均比と95%区間）, n（両群の少ない方の本数）,
 *       nT, nC（各群の本数）, medT, medC（各群の中央値）
 */
export type RuleVars = Partial<Record<RuleVar, number>>;
export type RuleVar = "ratio" | "lo" | "hi" | "n" | "nT" | "nC" | "medT" | "medC";
const VARS: RuleVar[] = ["ratio", "lo", "hi", "n", "nT", "nC", "medT", "medC"];
type Cmp = { v: RuleVar; op: ">=" | "<=" | ">" | "<"; x: number };
export type ParsedRule = Cmp[][]; // OR of ANDs

export function parseRule(src: string): ParsedRule {
  const text = src.trim();
  if (!text) throw new Error("式が空");
  return text.split("||").map(orPart => orPart.split("&&").map(term => {
    const m = term.trim().match(/^([A-Za-z]+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`式を読めない: "${term.trim()}"（例: ratio>=1.3）`);
    if (!VARS.includes(m[1] as RuleVar)) throw new Error(`使えない変数: ${m[1]}（${VARS.join(", ")}）`);
    return { v: m[1] as RuleVar, op: m[2] as Cmp["op"], x: Number(m[3]) };
  }));
}

/** 必要な変数が欠けている項は偽として扱う。 */
export function holds(src: string, vars: RuleVars): boolean {
  return parseRule(src).some(and => and.every(c => {
    const val = vars[c.v];
    if (val === undefined || Number.isNaN(val)) return false;
    switch (c.op) {
      case ">=": return val >= c.x;
      case "<=": return val <= c.x;
      case ">": return val > c.x;
      case "<": return val < c.x;
    }
  }));
}
