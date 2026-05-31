import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeCookies } from "./publishers/cookie-util.js";
import { launchStealthContext } from "./auth/captcha/stealth-context.js";
import { sleep, humanClick } from "./auth/captcha/human-mouse.js";

/**
 * Instagram の create flow を完全分析:
 *   1. home から '新しい投稿作成' click → サイドバー展開
 *   2. submenu の 'リール' / '投稿' リンクの DOM 構造 (href, onclick, data-*) を dump
 *   3. JS evaluate で直接 click を試行
 *   4. その結果の modal/URL を観察
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
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await sleep(5000);

  // notification dismiss
  for (const sel of ['button:has-text("後で")', 'button:has-text("Not Now")']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanClick(page, el);
      await sleep(2000);
      break;
    }
  }

  console.log("→ click 新しい投稿作成");
  const createBtn = page.locator('a[role="link"]:has-text("新しい投稿作成")').first();
  await humanClick(page, createBtn);
  await sleep(3500);
  console.log(`  url: ${page.url()}`);

  // submenu link の DOM 構造を全 dump
  console.log("\n=== 全 a[role=link] の attribute dump ===");
  const allLinks = await page.locator('a[role="link"]').all();
  for (let i = 0; i < allLinks.length; i++) {
    const el = allLinks[i];
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = ((await el.textContent().catch(() => "")) ?? "").trim();
    if (text.length === 0 || text.length > 30) continue;
    const href = await el.getAttribute("href").catch(() => "");
    const onclick = await el.getAttribute("onclick").catch(() => "");
    const dataAttrs = await el.evaluate((node: Element) => {
      const attrs: Record<string, string> = {};
      for (const a of node.attributes) attrs[a.name] = a.value;
      return attrs;
    }).catch(() => ({}));
    console.log(`  text="${text}" href="${href}" onclick="${onclick}"`);
    console.log(`    attrs: ${JSON.stringify(dataAttrs)}`);
  }

  await page.screenshot({ path: "/tmp/ig-after-create-click.png", fullPage: false });
  console.log("\n  saved /tmp/ig-after-create-click.png");

  // 「投稿」リンクを 4 種類の方法で click 試行
  const targetText = "投稿"; // または "リール"
  console.log(`\n=== '${targetText}' link click trials ===`);

  // Method 1: 通常の click
  console.log("\n[Method 1] page.locator click");
  const m1 = page.locator(`a[role="link"]:text-is("${targetText}")`).first();
  if (await m1.isVisible({ timeout: 2000 }).catch(() => false)) {
    await m1.click();
    await sleep(4000);
    console.log(`  url: ${page.url()}`);
    await page.screenshot({ path: "/tmp/ig-method1.png", fullPage: false });
  } else {
    console.log("  not visible");
  }

  // Reset: go back to home
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await sleep(3000);
  const create2 = page.locator('a[role="link"]:has-text("新しい投稿作成")').first();
  if (await create2.isVisible().catch(() => false)) {
    await humanClick(page, create2);
    await sleep(3000);
  }

  // Method 2: dispatchEvent
  console.log("\n[Method 2] dispatchEvent");
  const m2 = page.locator(`a[role="link"]:text-is("${targetText}")`).first();
  if (await m2.isVisible({ timeout: 2000 }).catch(() => false)) {
    await m2.dispatchEvent("click");
    await sleep(4000);
    console.log(`  url: ${page.url()}`);
    await page.screenshot({ path: "/tmp/ig-method2.png", fullPage: false });
  } else {
    console.log("  not visible");
  }

  // Reset
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await sleep(3000);
  const create3 = page.locator('a[role="link"]:has-text("新しい投稿作成")').first();
  if (await create3.isVisible().catch(() => false)) {
    await humanClick(page, create3);
    await sleep(3000);
  }

  // Method 3: evaluate でDOM .click()
  console.log("\n[Method 3] evaluate node.click()");
  try {
    await page.evaluate((text) => {
      const links = Array.from(document.querySelectorAll('a[role="link"]'));
      const target = links.find(a => (a.textContent || "").trim() === text);
      if (target) (target as HTMLElement).click();
    }, targetText);
    await sleep(4000);
    console.log(`  url: ${page.url()}`);
    await page.screenshot({ path: "/tmp/ig-method3.png", fullPage: false });
  } catch (e) {
    console.log(`  failed: ${e}`);
  }

  console.log("\n→ 60秒待機 (ブラウザで手動確認可)");
  await sleep(60_000);
  await ctx.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
