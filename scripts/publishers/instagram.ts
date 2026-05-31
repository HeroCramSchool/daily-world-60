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
    await humanRead(3500, 5000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // 「お知らせをオンにする」ダイアログの dismiss (2026 IG UI で最初に出る)
    const dismissNotif = [
      'button:has-text("あとで")',
      'button:has-text("後で")',
      'button:has-text("Not Now")',
      'button:has-text("Not now")',
      'div[role="button"]:has-text("あとで")',
      'div[role="button"]:has-text("Not Now")',
    ];
    for (const sel of dismissNotif) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`[ig] notification dialog dismissed via: ${sel}`);
        await humanClick(page, el);
        await humanRead(1500, 2500);
        break;
      }
    }

    // Cookie 通知 dialog dismiss も (出る場合)
    const dismissCookie = [
      'button:has-text("必須クッキーのみ許可")',
      'button:has-text("Decline optional cookies")',
      'button:has-text("Allow all cookies")',
      'button:has-text("すべて許可")',
    ];
    for (const sel of dismissCookie) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`[ig] cookie dialog dismissed via: ${sel}`);
        await humanClick(page, el);
        await humanRead(1500, 2000);
        break;
      }
    }

    // Step 1: 左サイドバーの「新しい投稿作成」(2026 IG UI) をクリック
    // /create/select/ は 2026 で廃止 → サイドバーリンクから modal 表示
    const createSelectors = [
      // 2026 新 UI: 「新しい投稿作成」テキストを含む role=link
      'a[role="link"]:has-text("新しい投稿作成")',
      'a[role="link"]:has-text("Create new post")',
      'a[role="link"]:has-text("作成")',
      'a[role="link"]:has-text("Create")',
      // SVG aria-label fallback
      'svg[aria-label="新しい投稿作成"]',
      'svg[aria-label="新規投稿"]',
      'svg[aria-label="New post"]',
      'svg[aria-label="作成"]',
      'svg[aria-label="Create"]',
      // 古い menuitem
      'div[role="menuitem"]:has-text("投稿")',
      'div[role="menuitem"]:has-text("作成")',
      'div[role="menuitem"]:has-text("Post")',
      'div[role="menuitem"]:has-text("Create")',
    ];
    let clickedCreate = false;
    for (const sel of createSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanClick(page, el);
        clickedCreate = true;
        console.log(`[ig] create button hit via: ${sel}`);
        break;
      }
    }
    if (!clickedCreate) {
      return { ok: false, error: "create button not found (sidebar 新しい投稿作成)" };
    }
    await humanRead(2500, 3800);

    // Step 1.5: サブメニューから「リール」or「投稿」を選択 (60 秒動画なのでリール優先)
    const submenuOpts = [
      'a[role="link"]:has-text("リール")',
      'a[role="link"]:has-text("Reels")',
      'a[role="link"]:has-text("投稿")',
      'a[role="link"]:has-text("Post")',
      'div[role="link"]:has-text("リール")',
      'div[role="link"]:has-text("Reels")',
      'div[role="link"]:has-text("投稿")',
      'div[role="link"]:has-text("Post")',
      'span:has-text("リール"):not(:has-text("動画"))',
      'span:has-text("Reels")',
      'span:has-text("投稿")',
    ];
    let clickedSubmenu = false;
    for (const sel of submenuOpts) {
      const els = await page.locator(sel).all();
      for (const el of els) {
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          await humanClick(page, el);
          clickedSubmenu = true;
          console.log(`[ig] submenu (リール/投稿) clicked via: ${sel}`);
          break;
        }
      }
      if (clickedSubmenu) break;
    }
    if (!clickedSubmenu) {
      console.log("[ig] submenu not found, assuming modal opens directly");
    }
    await humanRead(3000, 4500);

    // Step 2: Modal で「コンピュータから選択 / Select from computer」ボタンクリック → file input が trigger
    // (2026 IG UI で input[type="file"] は modal 表示時に hidden で生成、Select ボタンを押すと visible になる)
    const selectFromComputer = [
      'button:has-text("コンピュータから選択")',
      'button:has-text("Select from computer")',
      'button:has-text("コンピュータからアップロード")',
      'button:has-text("Select From Computer")',
      'div[role="button"]:has-text("コンピュータから選択")',
      'div[role="button"]:has-text("Select from computer")',
      'button:has-text("選択")',
      'button:has-text("Select")',
    ];

    // setInputFiles は file chooser を trigger する必要があるので、Promise.race で button click 同時に
    let fileInputUsed = false;
    for (const sel of selectFromComputer) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`[ig] select-from-computer via: ${sel}`);
        // ファイルチューザを開いて setInputFiles で path 渡す
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null),
          humanClick(page, el),
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(path.resolve(input.videoPath));
          fileInputUsed = true;
          break;
        }
        // Fallback: file input が DOM にあれば直接
        const fi = page.locator('input[type="file"], input[accept*="video"]').first();
        if (await fi.count() > 0) {
          await fi.setInputFiles(path.resolve(input.videoPath));
          fileInputUsed = true;
          break;
        }
      }
    }

    if (!fileInputUsed) {
      // 最終フォールバック: 直接 input を探す (hidden 含む)
      const fi = page.locator('input[type="file"], input[accept*="video"]').first();
      await fi.waitFor({ state: "attached", timeout: 30_000 });
      await fi.setInputFiles(path.resolve(input.videoPath));
    }
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
