/**
 * 見分けられる最小の差。有意水準5%（両側）・検出力80%、log(再生+1) の2群比較。
 * σ は台帳の sigma（2026-10-18 時点: 本編128本・経過7日以上で 1.41）。
 */
const Z = 1.96 + 0.84;

export function minDetectableRatio(nPerArm: number, sigma: number): number {
  if (!(nPerArm > 0)) return Infinity;
  return Math.exp(Z * sigma * Math.sqrt(2 / nPerArm));
}

export function nPerArmFor(ratio: number, sigma: number): number {
  if (!(ratio > 1)) return Infinity;
  return Math.ceil(2 * (Z * sigma / Math.log(ratio)) ** 2);
}
