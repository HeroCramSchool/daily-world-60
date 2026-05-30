import { chromium } from "playwright";
import { decodeCookies } from "./publishers/cookie-util.js";

/**
 * Cookie の有効性を確認する簡易テスト。
 *
 * Usage:
 *   npx tsx scripts/test-cookie.ts instagram
 *   npx tsx scripts/test-cookie.ts tiktok
 *   npx tsx scripts/test-cookie.ts x
 */

interface SiteCheck {
  envKey: string;
  url: string;
  loggedInSelector: string;
}

const SITES: Record<string, SiteCheck> = {
  instagram: {
    envKey: "INSTAGRAM_COOKIES_B64",
    url: "https://www.instagram.com/",
    loggedInSelector: 'svg[aria-label="新規投稿"], svg[aria-label="New post"], a[href*="/direct/"]',
  },
  tiktok: {
    envKey: "TIKTOK_COOKIES_B64",
    url: "https://www.tiktok.com/foryou",
    loggedInSelector: 'a[href*="/upload"], button[data-e2e="upload-icon"], a[href*="/tiktokstudio"], div[data-e2e="profile-icon"]',
  },
  x: {
    envKey: "X_COOKIES_B64",
    url: "https://x.com/home",
    loggedInSelector: 'a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]',
  },
};

async function main() {
  const site = process.argv[2];
  const check = SITES[site];
  if (!check) {
    console.error(`Usage: npx tsx scripts/test-cookie.ts <${Object.keys(SITES).join("|")}>`);
    process.exit(1);
  }

  const b64 = process.env[check.envKey];
  if (!b64) {
    console.error(`${check.envKey} not set`);
    process.exit(1);
  }

  // base64 has newlines stripped just in case
  const cleanB64 = b64.replace(/\s+/g, "");
  const cookies = decodeCookies(cleanB64);
  console.log(`[test] loaded ${cookies.length} cookies`);

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "ja-JP",
  });

  try {
    await ctx.addCookies(cookies);
  } catch (e) {
    console.error(`[test] addCookies error: ${e instanceof Error ? e.message : e}`);
  }
  const page = await ctx.newPage();
  await page.goto(check.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const loggedIn = await page.locator(check.loggedInSelector).first().isVisible().catch(() => false);
  console.log(`\n=== ${site.toUpperCase()} ===`);
  console.log(`URL after load: ${page.url()}`);
  console.log(`Logged in (selector visible): ${loggedIn ? "✅ YES" : "❌ NO"}`);

  if (loggedIn) {
    console.log("\n✅ Cookie 有効。15秒間ブラウザ表示してから閉じます。");
  } else {
    console.log("\n❌ Cookie 無効 or 期限切れ — Cookie-Editor で再取得してください。");
  }

  await page.waitForTimeout(15_000);
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
