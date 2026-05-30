import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type BrowserContext, type Cookie } from "playwright";

export interface IGPublishInput {
  videoPath: string;
  caption: string;
}

export interface IGPublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Instagram: Playwright で Web版にログインしてリール投稿。
 * Cookie は GitHub Secret INSTAGRAM_COOKIES_B64 (base64 of JSON array) から復元。
 * Cookie 期限切れ時は手動で再取得が必要。
 */
export async function publishInstagram(
  input: IGPublishInput,
): Promise<IGPublishResult> {
  const cookiesB64 = process.env.INSTAGRAM_COOKIES_B64;
  if (!cookiesB64) {
    return { ok: false, error: "INSTAGRAM_COOKIES_B64 not set" };
  }

  const cookies: Cookie[] = JSON.parse(
    Buffer.from(cookiesB64, "base64").toString("utf-8"),
  );

  const browser = await chromium.launch({ headless: true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // Click "+" Create button (icon-based, fragile)
    const createBtn = page
      .locator('a[href*="/reel"], svg[aria-label="新規投稿"], svg[aria-label="New post"]')
      .first();
    await createBtn.waitFor({ timeout: 15000 });
    await createBtn.click();
    await page.waitForTimeout(1500);

    // Choose Post (or Reel) and upload file
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.resolve(input.videoPath));
    await page.waitForTimeout(3000);

    // Click "Next" twice (crop → edit → caption)
    for (let i = 0; i < 2; i++) {
      const next = page.getByRole("button", { name: /next|次へ/i }).first();
      await next.waitFor({ timeout: 20000 });
      await next.click();
      await page.waitForTimeout(2000);
    }

    // Fill caption
    const captionArea = page.locator('div[contenteditable="true"]').first();
    await captionArea.waitFor({ timeout: 15000 });
    await captionArea.click();
    await captionArea.fill(input.caption.slice(0, 2200));
    await page.waitForTimeout(1500);

    // Share
    const share = page.getByRole("button", { name: /share|シェア|投稿/i }).first();
    await share.click();

    // Wait for confirmation
    await page.waitForSelector('text=/posted|投稿しました|shared/i', { timeout: 90000 });

    return { ok: true, url: "https://www.instagram.com/60dailyworld/" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (context) {
      // Persist updated cookies for the next run if needed
      try {
        const newCookies = await context.cookies();
        await fs.writeFile(
          path.join("output", "ig-cookies-latest.json"),
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
