import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { decodeCookies } from "./cookie-util.js";
import { launchStealthContext } from "../auth/captcha/stealth-context.js";
import { humanClick, humanType, humanRead, sleep } from "../auth/captcha/human-mouse.js";

export interface XPublishInput {
  thread: string[];
}

export interface XPublishResult {
  ok: boolean;
  url?: string;
  tweetIds?: string[];
  error?: string;
}

const PROFILE_DIR = path.join(process.env.HOME ?? "", ".config", "dailyworld60", "profile-x-pub");

/**
 * X (Twitter) で日本語スレッド投稿 @60dailyworld。
 * Stealth context + 人間風操作 (humanClick / humanType / humanRead)。
 */
export async function publishX(input: XPublishInput): Promise<XPublishResult> {
  const cookiesB64 = process.env.X_COOKIES_B64;
  if (!cookiesB64) return { ok: false, error: "X_COOKIES_B64 not set" };
  if (!input.thread || input.thread.length === 0) {
    return { ok: false, error: "empty thread" };
  }

  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const cookies = decodeCookies(cookiesB64);

  let ctx: BrowserContext | undefined;
  try {
    ctx = await launchStealthContext(PROFILE_DIR);
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await humanRead(2200, 3500);

    // Step 1: 「ポストする」ボタン
    const composeSelectors = [
      'a[data-testid="SideNav_NewTweet_Button"]',
      'a[href="/compose/post"]',
      'a[aria-label*="投稿"]',
      'a[aria-label*="Post"]',
    ];
    let opened = false;
    for (const sel of composeSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await humanClick(page, el);
        opened = true;
        break;
      }
    }
    if (!opened) {
      await page.goto("https://x.com/compose/post");
    }
    await humanRead(1500, 2500);

    // Step 2: 各ツイートを順に入力 + 「+」追加ボタン
    for (let i = 0; i < input.thread.length; i++) {
      const editor = page.locator(`div[data-testid="tweetTextarea_${i}"]`).first();
      await editor.waitFor({ timeout: 30_000 });
      await humanType(page, editor, input.thread[i].slice(0, 280));
      await humanRead(700, 1200);

      if (i < input.thread.length - 1) {
        const addBtn = page
          .locator('button[data-testid="addButton"], button[aria-label*="追加"], button[aria-label*="Add"]')
          .first();
        await addBtn.waitFor({ timeout: 10_000 });
        await humanClick(page, addBtn);
        await humanRead(800, 1400);
      }
    }

    // Step 3: 「すべてポスト」
    const postAllSelectors = [
      'button[data-testid="tweetButton"]',
      'button[data-testid="tweetButtonInline"]',
      'div[role="button"]:has-text("すべてポスト")',
      'div[role="button"]:has-text("Post all")',
    ];
    let submitted = false;
    for (const sel of postAllSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await humanClick(page, el);
        submitted = true;
        break;
      }
    }
    if (!submitted) {
      return { ok: false, error: "Post button not found" };
    }

    await page
      .waitForURL(/x\.com\/(home|60dailyworld)/, { timeout: 30_000 })
      .catch(() => {});
    await sleep(3000);

    return { ok: true, url: "https://x.com/60dailyworld" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (ctx) {
      try {
        const newCookies = await ctx.cookies();
        await fs.writeFile(
          path.join("output", "x-cookies-latest.json"),
          JSON.stringify(newCookies, null, 2),
          "utf-8",
        );
      } catch { /* ignore */ }
      try { await ctx.close(); } catch { /* ignore */ }
    }
  }
}
