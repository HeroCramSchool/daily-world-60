import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { decodeCookies } from "./cookie-util.js";
import { launchStealthContext } from "../auth/captcha/stealth-context.js";
import { humanClick, humanType, humanRead, sleep } from "../auth/captcha/human-mouse.js";

export interface IGPublishInput {
  videoPath: string;
  caption: string;
}

export interface IGPublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

const PROFILE_DIR = path.join(process.env.HOME ?? "", ".config", "dailyworld60", "profile-instagram-pub");

/**
 * Instagram に Reel として投稿。
 * - Stealth context + 永続プロファイル
 * - 人間風 click / type / 自然な間 (humanRead)
 * - DOM 変更耐性のため複数の selector を試す
 */
export async function publishInstagram(
  input: IGPublishInput,
): Promise<IGPublishResult> {
  const cookiesB64 = process.env.INSTAGRAM_COOKIES_B64;
  if (!cookiesB64) return { ok: false, error: "INSTAGRAM_COOKIES_B64 not set" };

  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const cookies = decodeCookies(cookiesB64);

  let ctx: BrowserContext | undefined;
  try {
    ctx = await launchStealthContext(PROFILE_DIR);
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    await humanRead(2200, 3500);

    // Step 1: 「+ Create / 作成」ボタン
    const createSelectors = [
      'svg[aria-label="新規投稿"]',
      'svg[aria-label="New post"]',
      'a[href="#"][role="link"]:has(svg[aria-label*="新規"])',
      'div[role="menuitem"]:has-text("投稿")',
      'a[href="/create/select/"]',
    ];
    let clickedCreate = false;
    for (const sel of createSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await humanClick(page, el);
        clickedCreate = true;
        break;
      }
    }
    if (!clickedCreate) {
      return { ok: false, error: "Create button not found" };
    }
    await humanRead(1500, 2500);

    // 「投稿」or「Reel」(動画なので Reel が望ましいが、UI 変動を許容)
    const postBtn = page.getByRole("button", { name: /reel|投稿|post/i }).first();
    if (await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanClick(page, postBtn);
      await humanRead(1200, 2000);
    }

    // Step 2: file upload
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(path.resolve(input.videoPath));
    await humanRead(3500, 5500);

    // Step 3: Next x2 (crop → edit)
    for (let i = 0; i < 2; i++) {
      const next = page.getByRole("button", { name: /next|次へ/i }).first();
      await next.waitFor({ timeout: 30_000 });
      await humanClick(page, next);
      await humanRead(1800, 2800);
    }

    // Step 4: Caption
    const captionArea = page.locator('div[contenteditable="true"][aria-label*="キャプション"], div[contenteditable="true"][aria-label*="caption"], div[contenteditable="true"]').first();
    await captionArea.waitFor({ timeout: 30_000 });
    await humanType(page, captionArea, input.caption.slice(0, 2200));
    await humanRead(1200, 2200);

    // Step 5: Share
    const share = page.getByRole("button", { name: /share|シェア|投稿/i }).first();
    await share.waitFor({ timeout: 30_000 });
    await humanClick(page, share);

    // Step 6: 完了確認
    await page
      .waitForSelector('text=/投稿しました|posted|shared|完了/i', { timeout: 120_000 })
      .catch(() => {});
    await sleep(2000);

    return { ok: true, url: "https://www.instagram.com/60dailyworld/" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (ctx) {
      try {
        const newCookies = await ctx.cookies();
        await fs.writeFile(
          path.join("output", "ig-cookies-latest.json"),
          JSON.stringify(newCookies, null, 2),
          "utf-8",
        );
      } catch { /* ignore */ }
      try { await ctx.close(); } catch { /* ignore */ }
    }
  }
}
