import type { Page, Locator } from "playwright";

/**
 * 人間っぽいマウス・キーボード・スクロール操作の共通ライブラリ。
 *
 * - すべての click は hover → わずかな遅延 → press → release
 * - 経路はベジエ曲線（ease-in-out）
 * - 終端で微小揺れ
 * - タイピングは1文字ずつ可変遅延 + たまにタイポ風遅延
 * - スクロールは段階的、加速・減速
 * - 各メイン操作の前後に「読んでる感」の自然な間
 */

let currentMouseX = 100;
let currentMouseY = 100;

export interface DragOptions {
  steps?: number;
  totalMs?: number;
  jitter?: number;
}

/** ベジエ + ease-in-out で滑らかに点へ移動 */
export async function humanMoveTo(
  page: Page,
  toX: number,
  toY: number,
  options?: { steps?: number; totalMs?: number },
): Promise<void> {
  const steps = options?.steps ?? 22 + Math.floor(Math.random() * 10);
  const totalMs = options?.totalMs ?? 350 + Math.random() * 300;

  const fromX = currentMouseX;
  const fromY = currentMouseY;
  // 軽く膨らむ制御点
  const cx1 = fromX + (toX - fromX) * 0.3 + (Math.random() * 60 - 30);
  const cy1 = fromY + (Math.random() * 40 - 20);
  const cx2 = fromX + (toX - fromX) * 0.7 + (Math.random() * 60 - 30);
  const cy2 = toY + (Math.random() * 40 - 20);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = easeInOutCubic(t);
    const x = cubicBezier(eased, fromX, cx1, cx2, toX) + (Math.random() - 0.5) * 0.8;
    const y = cubicBezier(eased, fromY, cy1, cy2, toY) + (Math.random() - 0.5) * 0.8;
    await page.mouse.move(x, y);
    await sleep(totalMs / steps + (Math.random() * 6 - 3));
  }
  currentMouseX = toX;
  currentMouseY = toY;
}

/** hover → 遅延 → press → release。ターゲット中心からわずかにオフセット */
export async function humanClick(
  page: Page,
  selectorOrLocator: string | Locator,
  options?: { holdMs?: number },
): Promise<void> {
  const locator =
    typeof selectorOrLocator === "string"
      ? page.locator(selectorOrLocator).first()
      : selectorOrLocator;

  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  const box = await locator.boundingBox();
  if (!box) {
    await locator.click();
    return;
  }

  // 中央ぴったりは避ける
  const offsetX = box.x + box.width / 2 + (Math.random() * 8 - 4);
  const offsetY = box.y + box.height / 2 + (Math.random() * 6 - 3);

  await humanMoveTo(page, offsetX, offsetY);
  await sleep(80 + Math.random() * 220);

  await page.mouse.down();
  await sleep(options?.holdMs ?? 40 + Math.random() * 80);
  await page.mouse.up();
}

/** click せず hover のみ（メニュー展開などに使う） */
export async function humanHover(page: Page, selectorOrLocator: string | Locator): Promise<void> {
  const locator =
    typeof selectorOrLocator === "string"
      ? page.locator(selectorOrLocator).first()
      : selectorOrLocator;
  const box = await locator.boundingBox();
  if (!box) {
    await locator.hover();
    return;
  }
  await humanMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** ベジエドラッグ（スライドパズル等） */
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

  await humanMoveTo(page, fromX, fromY);
  await sleep(120 + Math.random() * 80);
  await page.mouse.down();

  const cx1 = fromX + (toX - fromX) * 0.3 + (Math.random() * 30 - 15);
  const cy1 = fromY - 20 + Math.random() * 10;
  const cx2 = fromX + (toX - fromX) * 0.7 + (Math.random() * 30 - 15);
  const cy2 = fromY - 10 + Math.random() * 10;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = easeInOutCubic(t);
    const x = cubicBezier(eased, fromX, cx1, cx2, toX) + (Math.random() - 0.5) * 1.2;
    const y = cubicBezier(eased, fromY, cy1, cy2, toY) + (Math.random() - 0.5) * jitter;
    await page.mouse.move(x, y);
    await sleep(totalMs / steps + (Math.random() * 6 - 3));
  }
  currentMouseX = toX;
  currentMouseY = toY;
  await page.mouse.move(toX + (Math.random() - 0.5) * 0.8, toY);
  await sleep(80 + Math.random() * 60);
  await page.mouse.up();
}

/** 人間風タイピング: 文字ごとの可変遅延 + たまの「考え時間」 */
export async function humanType(
  page: Page,
  selectorOrLocator: string | Locator,
  text: string,
  options?: { mistakeChance?: number },
): Promise<void> {
  const locator =
    typeof selectorOrLocator === "string"
      ? page.locator(selectorOrLocator).first()
      : selectorOrLocator;
  await humanClick(page, locator);
  await sleep(180 + Math.random() * 220);

  const mistakeChance = options?.mistakeChance ?? 0;

  for (const ch of text) {
    if (mistakeChance > 0 && Math.random() < mistakeChance) {
      // たまにタイポ → 即 backspace
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? -1 : 1));
      await page.keyboard.type(typo, { delay: 60 + Math.random() * 80 });
      await sleep(180 + Math.random() * 180);
      await page.keyboard.press("Backspace");
      await sleep(60 + Math.random() * 100);
    }
    await page.keyboard.type(ch, { delay: 55 + Math.random() * 95 });
    // ときどき長い「考え時間」
    if (Math.random() < 0.04) {
      await sleep(380 + Math.random() * 520);
    }
  }
}

/** 段階的スクロール */
export async function humanScroll(page: Page, dy: number): Promise<void> {
  const totalSteps = 15 + Math.floor(Math.random() * 10);
  const remaining = dy;
  for (let i = 0; i < totalSteps; i++) {
    const t = i / totalSteps;
    // ease-out: 最初速く、徐々に減速
    const stepDy = (remaining / totalSteps) * (1 + (1 - t) * 0.5);
    await page.mouse.wheel(0, stepDy);
    await sleep(30 + Math.random() * 60);
  }
}

/** メイン操作の前後に「画面を読んでる」感のある自然な間 */
export async function humanRead(minMs = 800, maxMs = 1800): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
