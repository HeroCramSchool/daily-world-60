import type { Page } from "playwright";

/**
 * 人間っぽいマウス操作。
 * - ベジエ曲線で滑らかな経路
 * - 加速・減速プロファイル
 * - 微小な揺らぎ（ジッタ）
 */

export interface DragOptions {
  steps?: number;        // 経路上のサンプル数（多いほど滑らか・遅い）
  totalMs?: number;      // ドラッグ全体の所要時間
  jitter?: number;       // y方向の揺らぎ最大値 (px)
}

export async function humanDrag(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options?: DragOptions,
): Promise<void> {
  const steps = options?.steps ?? 40;
  const totalMs = options?.totalMs ?? 700 + Math.random() * 400;
  const jitter = options?.jitter ?? 3;

  // Bezier control points: 上に少し膨らむ自然なカーブ
  const cx1 = fromX + (toX - fromX) * 0.3 + (Math.random() * 30 - 15);
  const cy1 = fromY - 20 + (Math.random() * 10);
  const cx2 = fromX + (toX - fromX) * 0.7 + (Math.random() * 30 - 15);
  const cy2 = fromY - 10 + (Math.random() * 10);

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out で加速 → 減速
    const eased = easeInOutCubic(t);
    const x =
      cubicBezier(eased, fromX, cx1, cx2, toX) + (Math.random() - 0.5) * 1.2;
    const y =
      cubicBezier(eased, fromY, cy1, cy2, toY) +
      (Math.random() - 0.5) * jitter;
    await page.mouse.move(x, y, { steps: 1 });
    await sleep(totalMs / steps + (Math.random() * 6 - 3));
  }

  // 終端で少しだけ揺れて止まる
  await page.mouse.move(toX + (Math.random() - 0.5) * 0.8, toY);
  await sleep(80 + Math.random() * 60);
  await page.mouse.up();
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.click({ delay: 50 + Math.random() * 80 });
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 70 + Math.random() * 90 });
  }
}

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}
