import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeCookies } from "./publishers/cookie-util.js";
import { launchStealthContext } from "./auth/captcha/stealth-context.js";
import { sleep, humanClick } from "./auth/captcha/human-mouse.js";

/**
 * Instagram の新 Create flow を確認:
 *   home → 左サイドバー「+」 → dropdown menu → 「投稿」or「Reels」 → file picker
 */

const PROFILE_DIR = path.join(process.env.HOME ?? "", ".config", "dailyworld60", "profile-ig-debug");

async function main() {
  const cookieFile = path.join(process.env.HOME ?? "", ".config", "dailyworld60", "instagram-cookies.b64");
  const cookiesB64 = (await fs.readFile(cookieFile, "utf-8")).trim();
  const cookies = decodeCookies(cookiesB64);

  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const ctx = await launchStealthContext(PROFILE_DIR);
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();

  console.log("→ home");
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await sleep(5000);

  // notification dismiss
  const dismiss = [
    'button:has-text("後で")', 'button:has-text("あとで")',
    'button:has-text("Not Now")', 'button:has-text("Not now")',
  ];
  for (const sel of dismiss) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  dismiss via: ${sel}`);
      await humanClick(page, el);
      await sleep(2500);
      break;
    }
  }

  // 左サイドバーの「+」アイコン候補を列挙
  console.log("\n=== sidebar SVG aria-label ===");
  const svgs = await page.locator("svg[aria-label]").all();
  for (let i = 0; i < Math.min(svgs.length, 30); i++) {
    const el = svgs[i];
    const aria = await el.getAttribute("aria-label").catch(() => "");
    const visible = await el.isVisible().catch(() => false);
    console.log(`  [${i}] vis=${visible} aria="${aria || ""}"`);
  }

  console.log("\n→ click '新しい投稿作成' link");
  const newPostBtn = page.locator('a[role="link"]:has-text("新しい投稿作成"), a[role="link"]:has-text("Create new post")').first();
  if (await newPostBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await humanClick(page, newPostBtn);
    await sleep(3000);
    console.log("  clicked");
  } else {
    console.log("  not found");
  }

  // 「リール」 submenu click
  console.log("\n→ click 'リール' submenu");
  const reelBtn = page.locator('a[role="link"]:has-text("リール"), a[role="link"]:has-text("Reels")').first();
  if (await reelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await humanClick(page, reelBtn);
    await sleep(6000);
    console.log("  clicked + waited 6s");
  } else {
    console.log("  not found");
  }

  console.log(`\n  url after reel click: ${page.url()}`);
  await fs.writeFile("/tmp/ig-debug-after-reel.html", await page.content(), "utf-8");
  await page.screenshot({ path: "/tmp/ig-debug-after-reel.png", fullPage: false });
  console.log("  saved /tmp/ig-debug-after-reel.{html,png}");

  // file input チェック + 全 visible button text
  const fiCount = await page.locator('input[type="file"]').count();
  const fiVideo = await page.locator('input[accept*="video"]').count();
  console.log(`  input[type=file]: ${fiCount}, input[accept*=video]: ${fiVideo}`);

  console.log("\n=== visible buttons after reel ===");
  const btnsAfter = await page.locator('button, div[role="button"]').all();
  for (let i = 0; i < Math.min(btnsAfter.length, 25); i++) {
    const el = btnsAfter[i];
    const text = ((await el.textContent().catch(() => "")) ?? "").trim();
    const vis = await el.isVisible().catch(() => false);
    if (text && vis && text.length < 50) {
      console.log(`  "${text}"`);
    }
  }

  // click 後の DOM dump (dropdown / modal がどう出ているか)
  await fs.writeFile("/tmp/ig-debug-after-create-click.html", await page.content(), "utf-8");
  await page.screenshot({ path: "/tmp/ig-debug-after-create-click.png", fullPage: false });
  console.log("  saved /tmp/ig-debug-after-create-click.{html,png}");

  // dropdown menu 候補を見る
  console.log("\n=== dropdown / modal visible items after create click ===");
  // dialog / menu role
  for (const role of ['dialog', 'menu', 'menuitem']) {
    const els = await page.locator(`[role="${role}"]`).all();
    console.log(`  role=${role}: ${els.length} found`);
    for (const el of els.slice(0, 10)) {
      const text = ((await el.textContent().catch(() => "")) ?? "").trim().slice(0, 80);
      const visible = await el.isVisible().catch(() => false);
      console.log(`    vis=${visible} "${text}"`);
    }
  }
  // text 検索: '投稿', 'リール', 'Post', 'Reel', 'Story', 'Live', '選択', 'コンピュータ'
  console.log("\n=== text searches ===");
  for (const text of ['投稿', 'リール', 'Reel', 'Post', 'Story', 'Live', '選択', 'コンピュータ', 'computer', 'Select']) {
    const els = await page.locator(`text="${text}"`).all();
    let visibleN = 0;
    for (const el of els) {
      if (await el.isVisible().catch(() => false)) visibleN++;
    }
    if (visibleN > 0) console.log(`  "${text}": ${visibleN} visible / ${els.length} total`);
  }
  const fileInputCount = await page.locator('input[type="file"]').count();
  const fileInputVideo = await page.locator('input[accept*="video"]').count();
  console.log(`\n  input[type=file]: ${fileInputCount}, input[accept*=video]: ${fileInputVideo}`);

  // dropdown menu (Post / Reels / Story / Live)
  console.log("\n=== after click: visible buttons / role=link ===");
  const items = await page.locator('div[role="menuitem"], a[role="link"], div[role="button"], button, span').all();
  for (let i = 0; i < Math.min(items.length, 40); i++) {
    const el = items[i];
    const text = (await el.textContent().catch(() => "") ?? "").trim();
    const visible = await el.isVisible().catch(() => false);
    const role = await el.getAttribute("role").catch(() => "");
    const href = await el.getAttribute("href").catch(() => "");
    if (text && text.length < 20 && visible) {
      console.log(`  [${i}] role=${role} text="${text}" href="${href ?? ""}"`);
    }
  }

  await fs.writeFile("/tmp/ig-debug-dropdown.html", await page.content(), "utf-8");
  await page.screenshot({ path: "/tmp/ig-debug-dropdown.png", fullPage: true });
  console.log("  saved /tmp/ig-debug-dropdown.{html,png}");

  // 「投稿」or「Post」をクリック
  console.log("\n→ click Post / 投稿");
  const postOpts = [
    'a[href*="/create/style/"]',
    'a:has-text("投稿")',
    'a:has-text("Post")',
    'div[role="menuitem"]:has-text("投稿")',
    'div[role="menuitem"]:has-text("Post")',
    'span:has-text("投稿")',
    'span:has-text("Post")',
  ];
  let clicked = false;
  for (const sel of postOpts) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  via ${sel}`);
      await humanClick(page, el);
      clicked = true;
      break;
    }
  }
  if (!clicked) console.log("  no Post option found");
  await sleep(5000);

  // Select from computer フェーズ
  console.log("\n=== after Post click ===");
  console.log(`  url: ${page.url()}`);
  await fs.writeFile("/tmp/ig-debug-after-post.html", await page.content(), "utf-8");
  await page.screenshot({ path: "/tmp/ig-debug-after-post.png", fullPage: true });

  // file input?
  const fi = await page.locator('input[type="file"]').count();
  console.log(`  input[type=file] count: ${fi}`);

  // visible buttons with text
  const buttons = await page.locator('button, div[role="button"]').all();
  console.log("\n=== buttons after Post ===");
  for (let i = 0; i < Math.min(buttons.length, 30); i++) {
    const el = buttons[i];
    const text = (await el.textContent().catch(() => "") ?? "").trim();
    const visible = await el.isVisible().catch(() => false);
    if (text && visible && text.length < 40) {
      console.log(`  [${i}] "${text}"`);
    }
  }

  console.log("\n→ 30秒待機 (実機確認用)");
  await sleep(30_000);
  await ctx.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
