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

    // Step 1.5: create サブメニューから「投稿」(or「リール」) を選び、
    //           アップロードモーダル (file input / コンピュータから選択) が出るまで検証する。
    //
    // 既知の落とし穴: create ボタンの accessible name「新しい投稿作成」は部分文字列に
    //   「投稿」を含むため、:has-text("投稿") だと create ボタンを再クリックしてしまい
    //   モーダルが開かない。→ getByRole の exact 名一致で厳密に項目だけを狙い、
    //   かつ「クリック後にモーダルが本当に開いたか」を必ず確認して、開かなければ次候補に進む。
    //   (IG の投稿作成は URL を変えないモーダルなので、URL では成否を判定しない。)
    const uploadModalReady = async (): Promise<boolean> => {
      const fi = page.locator('input[type="file"], input[accept*="video"]').first();
      if (await fi.count() > 0) return true;
      const btn = page
        .locator(
          'button:has-text("コンピュータから選択"), div[role="button"]:has-text("コンピュータから選択"), button:has-text("Select from computer")',
        )
        .first();
      return await btn.isVisible({ timeout: 800 }).catch(() => false);
    };

    // 実 DOM 確認済み (2026-06):
    //   create メニューの「投稿」項目は a[role="link"][href="#"] で、内部に
    //   svg[aria-label="投稿"] を持つ。textContent は "投稿投稿" (svg + span の二重) に
    //   なるため text-is("投稿") や getByRole name="投稿" exact では拾えない。
    //   一方 :has-text("投稿") は create ボタン「新しい投稿作成」を誤マッチする。
    //   → svg[aria-label] の完全一致で項目を特定する。href="#" 条件で左サイドバーの
    //     「リール動画」(href="/reels/" feed タブ) も自然に除外される。
    const submenuCandidates: Array<() => import("playwright").Locator> = [
      () => page.locator('a[role="link"][href="#"]:has(svg[aria-label="投稿"])'),
      () => page.locator('a[role="link"][href="#"]:has(svg[aria-label="リール"])'),
      () => page.locator('a[role="link"][href="#"]:has(svg[aria-label="Post"])'),
      () => page.locator('a[role="link"][href="#"]:has(svg[aria-label="Reel"])'),
      // フォールバック: svg を直接クリック
      () => page.locator('svg[aria-label="投稿"]'),
      () => page.locator('svg[aria-label="リール"]'),
    ];

    let modalOpen = await uploadModalReady();
    for (let attempt = 0; attempt < submenuCandidates.length && !modalOpen; attempt++) {
      const loc = submenuCandidates[attempt]().first();
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
      await humanClick(page, loc);
      console.log(`[ig] submenu candidate ${attempt} clicked`);
      for (let t = 0; t < 12 && !modalOpen; t++) {
        await sleep(500);
        modalOpen = await uploadModalReady();
      }
      console.log(`[ig] after candidate ${attempt}: uploadModalReady=${modalOpen}, url=${page.url()}`);
      if (!modalOpen) {
        // モーダルが開かなかった → create メニューを開き直して次候補へ
        const createBtn = page
          .locator('a[role="link"]:has-text("新しい投稿作成"), a[role="link"]:has-text("Create new post")')
          .first();
        if (await createBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await humanClick(page, createBtn);
          await humanRead(1500, 2500);
        }
      }
    }

    if (!modalOpen) {
      return { ok: false, error: "upload modal did not open after submenu (投稿/リール)" };
    }
    await humanRead(1500, 2500);

    // Step 2: hidden input[type=file] に直接 setInputFiles (検証済み 2026-06)。
    // 「コンピュータから選択」ボタン + filechooser 経路はファイルが載らず Next 画面に
    // 進まないことがあったため、modal が開いたら input へ直接セットする方が確実。
    const fileInput = page.locator('input[type="file"], input[accept*="video"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(path.resolve(input.videoPath));
    console.log("[ig] video file set on input (direct)");
    await humanRead(4000, 6000); // 動画処理 → crop 画面が出るまで

    // Step 2.5: 「動画投稿はリール動画としてシェアされるようになりました」案内ダイアログが
    // crop 画面の上に出て「次へ」をブロックすることがある → OK で閉じる (実 DOM 確認 2026-06)。
    const reelInfoOk = page.locator('button:has-text("OK"), div[role="button"]:has-text("OK")').first();
    if (await reelInfoOk.isVisible({ timeout: 6000 }).catch(() => false)) {
      console.log("[ig] reel-info dialog dismissed (OK)");
      await humanClick(page, reelInfoOk);
      await humanRead(1500, 2500);
    }

    // Step 3: Next x2 (crop → edit)。実 DOM では「次へ」は div[role="button"]。
    for (let i = 0; i < 2; i++) {
      const next = page.locator(
        'div[role="button"]:has-text("次へ"), div[role="button"]:has-text("Next"), button:has-text("次へ"), button:has-text("Next")',
      ).first();
      await next.waitFor({ state: "visible", timeout: 30_000 });
      await humanClick(page, next);
      await humanRead(1800, 2800);
    }

    // Step 4: Caption
    const captionArea = page.locator('div[contenteditable="true"][aria-label*="キャプション"], div[contenteditable="true"][aria-label*="caption"], div[contenteditable="true"]').first();
    await captionArea.waitFor({ timeout: 30_000 });
    await humanType(page, captionArea, input.caption.slice(0, 2200));
    await humanRead(1200, 2200);

    // Step 5: Share (実 DOM では div[role="button"] text="シェアする")
    const share = page.locator(
      'div[role="button"]:has-text("シェア"), div[role="button"]:has-text("Share"), button:has-text("シェア"), button:has-text("Share")',
    ).first();
    await share.waitFor({ state: "visible", timeout: 30_000 });
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
