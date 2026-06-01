import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { decodeCookies } from "./cookie-util.js";
import { launchStealthContext } from "../auth/captcha/stealth-context.js";
import { humanClick, humanType, humanRead, sleep } from "../auth/captcha/human-mouse.js";
import { tryAutoSolveCaptcha } from "../auth/captcha/index.js";

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

const PROFILE_DIR = path.join(process.env.HOME ?? "", ".config", "dailyworld60", "profile-tiktok-pub");

export async function publishTikTok(
  input: TikTokPublishInput,
): Promise<TikTokPublishResult> {
  const cookiesB64 = process.env.TIKTOK_COOKIES_B64;
  if (!cookiesB64) return { ok: false, error: "TIKTOK_COOKIES_B64 not set" };

  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const cookies = decodeCookies(cookiesB64);

  let ctx: BrowserContext | undefined;
  try {
    ctx = await launchStealthContext(PROFILE_DIR);
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // 初回 (cold profile) は TikTok Studio へ直行すると file input が現れないことがある
    // (story1 だけ "file input not found" になる症状)。先に home を踏んでセッションを温め、
    // upload ページは「失敗したら reload して再試行」する。
    await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await humanRead(3000, 5000);

    // Step 1: file upload (selector を拡張 + cold-start 用に reload 再試行)
    const fileInputSelectors = [
      'input[type="file"]',
      'input[accept*="video"]',
      'input[accept*="mp4"]',
    ];
    const findFileInput = async (timeoutMs: number) => {
      for (const sel of fileInputSelectors) {
        const el = page.locator(sel).first();
        try {
          await el.waitFor({ state: "attached", timeout: timeoutMs });
          console.log(`[tiktok] file input found via: ${sel}`);
          return el;
        } catch { /* try next */ }
      }
      return null;
    };

    let fileInput = null;
    for (let attempt = 1; attempt <= 2 && !fileInput; attempt++) {
      await page.goto("https://www.tiktok.com/tiktokstudio/upload", { waitUntil: "domcontentloaded" });
      // ページが完全に初期化されるまで長めに待つ
      await humanRead(6000, 9000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await tryAutoSolveCaptcha(page);
      await humanRead(2000, 3000);
      fileInput = await findFileInput(attempt === 1 ? 40_000 : 60_000);
      if (!fileInput) console.log(`[tiktok] file input not found (attempt ${attempt}/2), reloading...`);
    }
    if (!fileInput) {
      return { ok: false, error: "file input not found" };
    }
    await fileInput.setInputFiles(path.resolve(input.videoPath));
    await humanRead(8000, 12_000); // 動画処理の長め待ち

    // Step 2: caption
    const captionSelectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'div[data-text="true"]',
    ];
    let captionArea = null;
    for (const sel of captionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        captionArea = el;
        break;
      }
    }
    if (captionArea) {
      // 既存テキスト（ファイル名等）を削除
      await humanClick(page, captionArea);
      await sleep(400);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Meta+A").catch(() => {});
      await sleep(150);
      await page.keyboard.press("Delete");
      await sleep(300);
      await humanType(page, captionArea, input.caption.slice(0, 2200));
      await humanRead(1500, 2500);
    }

    // Step 3: Post / 公開
    const postBtnSelectors = [
      'button[data-e2e="post_video_button"]',
      'button:has-text("投稿")',
      'button:has-text("Post")',
      'button:has-text("公開")',
    ];
    let posted = false;
    for (const sel of postBtnSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await humanClick(page, el);
        posted = true;
        break;
      }
    }

    if (!posted) {
      return { ok: false, error: "Post button not found" };
    }

    // 完了 or 検証要求待ち
    await page
      .waitForURL(/posts|manage|upload\/?$/, { timeout: 120_000 })
      .catch(() => {});
    await sleep(3000);

    return { ok: true, url: "https://www.tiktok.com/@60dailyworld" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (ctx) {
      try {
        const newCookies = await ctx.cookies();
        await fs.writeFile(
          path.join("output", "tiktok-cookies-latest.json"),
          JSON.stringify(newCookies, null, 2),
          "utf-8",
        );
      } catch { /* ignore */ }
      try { await ctx.close(); } catch { /* ignore */ }
    }
  }
}
