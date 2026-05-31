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

  // 左サイドバーの「+」アイコン候補を列挙
  console.log("\n=== sidebar SVG aria-label ===");
  const svgs = await page.locator("svg[aria-label]").all();
  for (let i = 0; i < Math.min(svgs.length, 30); i++) {
    const el = svgs[i];
    const aria = await el.getAttribute("aria-label").catch(() => "");
    const visible = await el.isVisible().catch(() => false);
    console.log(`  [${i}] vis=${visible} aria="${aria || ""}"`);
  }

  // 「新しい投稿作成」role=link をクリック (2026 UI)
  console.log("\n→ click '新しい投稿作成' link");
  const newPostBtn = page.locator('a[role="link"]:has-text("新しい投稿作成"), a[role="link"]:has-text("Create new post")').first();
  if (await newPostBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await humanClick(page, newPostBtn);
    await sleep(3500);
    console.log("  clicked");
  } else {
    console.log("  not found");
  }

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
