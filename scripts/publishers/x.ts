import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { decodeCookies } from "./cookie-util.js";

export interface XPublishInput {
  thread: string[];
}

export interface XPublishResult {
  ok: boolean;
  url?: string;
  tweetIds?: string[];
  error?: string;
}

/**
 * X (Twitter) — Playwright で Web から日本語スレッド投稿。
 *
 * - Cookie は GitHub Secret X_COOKIES_B64 から復元
 * - スレッドはモーダル内で「+ ポストを追加」を repeat
 * - 「すべてポスト」で確定送信
 *
 * 投稿先: @60dailyworld
 */
export async function publishX(input: XPublishInput): Promise<XPublishResult> {
  const cookiesB64 = process.env.X_COOKIES_B64;
  if (!cookiesB64) return { ok: false, error: "X_COOKIES_B64 not set" };
  if (!input.thread || input.thread.length === 0) {
    return { ok: false, error: "empty thread" };
  }

  const cookies = decodeCookies(cookiesB64);

  const browser = await chromium.launch({ headless: true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    // 1. ホームに移動
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // 2. 「ポストする」ボタン
    const composeBtn = page
      .locator('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]')
      .first();
    await composeBtn.waitFor({ timeout: 15000 });
    await composeBtn.click();
    await page.waitForTimeout(2000);

    // 3. 1つ目入力 → 「+ もう一つ追加」を repeat
    for (let i = 0; i < input.thread.length; i++) {
      // 現在のスレッド最後尾のテキストエリアを掴む
      const editors = page.locator('div[data-testid="tweetTextarea_0"], div[data-testid^="tweetTextarea_"]');
      const editor = editors.nth(i);
      await editor.waitFor({ timeout: 15000 });
      await editor.click();
      await page.waitForTimeout(300);
      // type で1文字ずつ送る（一気に貼り付けるとイベントが発火しないことがある）
      await page.keyboard.type(input.thread[i].slice(0, 280), { delay: 5 });
      await page.waitForTimeout(800);

      if (i < input.thread.length - 1) {
        // 「+」ボタン: data-testid="addButton"
        const addBtn = page
          .locator('button[data-testid="addButton"], button[aria-label*="追加"], button[aria-label*="Add"]')
          .first();
        await addBtn.waitFor({ timeout: 10000 });
        await addBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // 4. 「すべてポスト」 / "Post all"
    const postAllBtn = page
      .locator(
        [
          'button[data-testid="tweetButton"]',
          'button[data-testid="tweetButtonInline"]',
          'div[role="button"]:has-text("すべてポスト")',
          'div[role="button"]:has-text("Post all")',
        ].join(", "),
      )
      .first();
    await postAllBtn.waitFor({ timeout: 15000 });
    await postAllBtn.click();

    // 5. 完了確認: モーダルが閉じる or タイムラインに戻る
    await page
      .waitForURL(/x\.com\/(home|60dailyworld)/, { timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(3000);

    return { ok: true, url: "https://x.com/60dailyworld" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (context) {
      try {
        const newCookies = await context.cookies();
        await fs.writeFile(
          path.join("output", "x-cookies-latest.json"),
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
