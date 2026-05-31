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

    // 3 ツイートを個別に投稿 (スレッド「+」ボタンが新 UI で不安定なため)
    const postedCount: number[] = [];
    for (let i = 0; i < input.thread.length; i++) {
      await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
      await humanRead(2000, 3200);

      const editor = page.locator('div[data-testid="tweetTextarea_0"]').first();
      try {
        await editor.waitFor({ timeout: 30_000 });
      } catch {
        console.log(`[x] tweet ${i+1}: editor not found, skipping`);
        continue;
      }
      await humanType(page, editor, input.thread[i].slice(0, 280));
      await humanRead(700, 1200);

      const postSelectors = [
        'button[data-testid="tweetButton"]',
        'button[data-testid="tweetButtonInline"]',
        'div[role="button"][data-testid="tweetButton"]',
        'div[role="button"]:has-text("ポストする")',
        'div[role="button"]:has-text("Post")',
      ];
      let posted = false;
      for (const sel of postSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
          await humanClick(page, el);
          posted = true;
          break;
        }
      }
      if (posted) {
        await sleep(5000); // 投稿完了 + rate limit 待ち
        postedCount.push(i + 1);
        console.log(`[x] tweet ${i+1}/${input.thread.length} ✓`);
      } else {
        console.log(`[x] tweet ${i+1}: post button not found`);
      }
    }

    if (postedCount.length === 0) {
      return { ok: false, error: "no tweets posted" };
    }

    return { ok: true, url: "https://x.com/60dailyworld", tweetIds: postedCount.map(String) };
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
      await sleep(1500); // profile file handle flush
    }
  }
}
