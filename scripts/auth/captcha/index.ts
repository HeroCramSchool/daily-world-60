import type { Page } from "playwright";
import { solveTikTokSlider } from "./tiktok-slider.js";

export { launchStealthContext } from "./stealth-context.js";
export { humanDrag, humanType } from "./human-mouse.js";
export { solveTikTokSlider } from "./tiktok-slider.js";

/**
 * 共通: ページ上に CAPTCHA を見つけたら、対応する solver を起動する。
 * 成功すれば true、解けなかったら false。
 */
export async function tryAutoSolveCaptcha(page: Page): Promise<boolean> {
  // TikTok スライダー
  const tiktokSlider = page.locator(
    [
      ".captcha_verify_img_slide",
      'img[class*="captcha_verify_img_slide"]',
      'img[id*="captcha-verify-image"]',
    ].join(", "),
  );
  if ((await tiktokSlider.count()) > 0) {
    console.log("[captcha] TikTok slider detected, solving...");
    return await solveTikTokSlider(page);
  }

  // reCAPTCHA v2 (image grid)
  const recaptcha = page.locator('iframe[src*="recaptcha"]');
  if ((await recaptcha.count()) > 0) {
    console.warn("[captcha] reCAPTCHA detected — Vision solver not yet implemented");
    // TODO: Claude Vision API integration
    return false;
  }

  return false;
}
