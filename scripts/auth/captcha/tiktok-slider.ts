import sharp from "sharp";
import type { Page } from "playwright";
import { humanDrag } from "./human-mouse.js";

/**
 * TikTok / ByteDance のスライドパズル CAPTCHA を解く。
 *
 * 戦略:
 * 1) 背景画像とパズルピース画像のスクショを取る
 * 2) sharp で edge map を計算
 * 3) ピースの x 座標を 0..W で sliding し、edge map との一致度が最大の x を gap とする
 * 4) スライダーを gap までドラッグ（人間風）
 */

const SELECTORS = {
  bg: [
    ".captcha_verify_img_slide",
    'img[class*="captcha_verify_img_slide"]',
    'img[id*="captcha-verify-image"]',
    'img[class*="bgImg"]',
  ].join(", "),
  piece: [
    ".captcha_verify_img--slide",
    'img[class*="captcha_verify_img--slide"]',
    'img[class*="puzzle"]',
    'img[class*="sliderImg"]',
  ].join(", "),
  slider: [
    ".captcha_verify_slide--slidebar",
    '[class*="slider-button"]',
    '[class*="slideBar"]',
    '[class*="captcha_slide_button"]',
    'div[role="slider"]',
  ].join(", "),
};

export async function solveTikTokSlider(page: Page): Promise<boolean> {
  // Try multiple attempts (TikTok sometimes shows multiple puzzles in succession)
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await tryOnce(page);
    if (!ok) return false;
    // パズルが消えれば成功
    await page.waitForTimeout(2500);
    const stillPresent = await page.locator(SELECTORS.bg).count();
    if (stillPresent === 0) return true;
    console.log(`[tiktok-slider] still present after attempt ${attempt + 1}, retrying`);
  }
  return false;
}

async function tryOnce(page: Page): Promise<boolean> {
  const bgEl = page.locator(SELECTORS.bg).first();
  const pieceEl = page.locator(SELECTORS.piece).first();
  const sliderEl = page.locator(SELECTORS.slider).first();

  const bgVisible = await bgEl.isVisible().catch(() => false);
  if (!bgVisible) {
    return false;
  }

  const [bgBuf, pieceBuf, bgBB, sliderBB] = await Promise.all([
    bgEl.screenshot(),
    pieceEl.screenshot().catch(() => Buffer.alloc(0)),
    bgEl.boundingBox(),
    sliderEl.boundingBox(),
  ]);

  if (!bgBB || !sliderBB) {
    console.warn("[tiktok-slider] bounding box missing");
    return false;
  }

  // Compute the slider target x within the bg image
  const bgImage = await sharp(bgBuf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = bgImage.info.width;
  const H = bgImage.info.height;
  const pixels = bgImage.data;

  let pieceWidth = 60; // default fallback
  if (pieceBuf.length > 0) {
    const pieceMeta = await sharp(pieceBuf).metadata();
    pieceWidth = pieceMeta.width ?? pieceWidth;
  }

  // Find vertical "edge" with highest gradient — this typically marks the gap
  const colScores = new Array<number>(W).fill(0);
  for (let x = 1; x < W - 1; x++) {
    let score = 0;
    for (let y = 0; y < H; y++) {
      const left = pixels[y * W + (x - 1)];
      const right = pixels[y * W + (x + 1)];
      score += Math.abs(right - left);
    }
    colScores[x] = score;
  }

  // ignore the first ~40px (avoids the piece itself which sits at far left initially)
  let bestX = 0;
  let bestScore = -1;
  for (let x = 50; x < W - 5; x++) {
    if (colScores[x] > bestScore) {
      bestScore = colScores[x];
      bestX = x;
    }
  }

  // gap center ≈ bestX, slider needs to move by (gap_x_in_bg − piece_left_in_bg − pieceWidth/2)
  // Practically: drag the slider by `bestX − offset` pixels, where offset ≈ 5–10 (piece initial x)
  const dragPx = Math.max(20, bestX - 6);
  console.log(`[tiktok-slider] target gap x=${bestX}, dragging ${dragPx}px (pieceWidth=${pieceWidth})`);

  const startX = sliderBB.x + sliderBB.width / 2;
  const startY = sliderBB.y + sliderBB.height / 2;
  // scale factor: bg image pixels-per-slider-pixel
  // The slider bar typically spans roughly the same width as the bg image.
  // We assume 1:1 (most TikTok layouts).
  const endX = startX + dragPx;
  const endY = startY;

  await humanDrag(page, startX, startY, endX, endY, {
    steps: 60,
    totalMs: 900 + Math.random() * 600,
    jitter: 4,
  });

  return true;
}
