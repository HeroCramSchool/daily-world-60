import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { decodeCookies } from "./cookie-util.js";

export interface TikTokPublishInput {
  videoPath: string;
  caption: string;
}

export interface TikTokPublishResult {
  ok: boolean;
  url?: string;
  draft?: boolean;
  error?: string;
}

/**
 * TikTok: Playwright で Web版にログイン → studio から動画アップロード。
 * Cookie は GitHub Secret TIKTOK_COOKIES_B64 (base64 of JSON array) から復元。
 */
export async function publishTikTok(
  input: TikTokPublishInput,
): Promise<TikTokPublishResult> {
  const cookiesB64 = process.env.TIKTOK_COOKIES_B64;
  if (!cookiesB64) {
    return { ok: false, error: "TIKTOK_COOKIES_B64 not set" };
  }

  const cookies = decodeCookies(cookiesB64);

  const browser = await chromium.launch({ headless: true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    await page.goto("https://www.tiktok.com/tiktokstudio/upload", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // Upload file
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.resolve(input.videoPath));
    await page.waitForTimeout(8000); // 動画処理待ち

    // Fill caption
    const captionArea = page.locator('div[contenteditable="true"]').first();
    await captionArea.waitFor({ timeout: 30000 });
    await captionArea.click();
    await captionArea.fill(input.caption.slice(0, 2200));
    await page.waitForTimeout(2000);

    // Click "Post" button
    const postBtn = page.getByRole("button", { name: /post|公開|投稿/i }).first();
    await postBtn.waitFor({ timeout: 20000 });
    await postBtn.click();

    // Wait for confirmation (URL change or success message)
    await page
      .waitForURL(/manage|upload/, { timeout: 90000 })
      .catch(() => {});

    return { ok: true, url: "https://www.tiktok.com/@60dailyworld" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (context) {
      try {
        const newCookies = await context.cookies();
        await fs.writeFile(
          path.join("output", "tiktok-cookies-latest.json"),
          JSON.stringify(newCookies, null, 2),
          "utf-8",
        );
      } catch {
        /* ignore */
      }
    }
    await browser.close();
  }
}
