import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Page } from "playwright";
import { launchStealthContext, tryAutoSolveCaptcha, humanType } from "./captcha/index.js";
import { getVerificationCode } from "./get-verification-code.js";

/**
 * 完全自動 SNS Cookie 取得スクリプト。
 *
 * 機能:
 * - playwright-extra + stealth plugin で bot 検出を最大限回避
 * - 本物 Chrome (channel: "chrome") + 永続プロファイル
 * - Fingerprint 偽装 (webdriver / languages / plugins / WebGL)
 * - TikTok スライドパズル自動解決
 * - メール認証コードを Gmail API から自動取得して入力
 * - 人間風マウス操作・タイピング
 *
 * Usage:
 *   npx tsx scripts/auth/get-sns-cookies.ts                # all three
 *   npx tsx scripts/auth/get-sns-cookies.ts tiktok         # one
 *   npx tsx scripts/auth/get-sns-cookies.ts instagram tiktok
 *
 * 環境変数 (省略時は手動ログイン):
 *   SNS_USERNAME_X / SNS_PASSWORD_X
 *   SNS_USERNAME_IG / SNS_PASSWORD_IG
 *   SNS_USERNAME_TIKTOK / SNS_PASSWORD_TIKTOK
 *   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
 */

interface Site {
  name: "x" | "instagram" | "tiktok";
  label: string;
  loginUrl: string;
  domains: string[];
  loggedInSelector: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  codeInputSelector?: string;
  gmailService: "x" | "instagram" | "tiktok" | "google";
  envUserKey: string;
  envPassKey: string;
}

const SITES: Site[] = [
  {
    name: "x",
    label: "X (Twitter)",
    loginUrl: "https://x.com/login",
    domains: ["x.com", ".x.com", "twitter.com", ".twitter.com"],
    loggedInSelector: 'a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]',
    usernameSelector: 'input[autocomplete="username"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'div[role="button"]:has-text("Log in"), div[role="button"]:has-text("ログイン")',
    codeInputSelector: 'input[name="text"], input[autocomplete="one-time-code"]',
    gmailService: "x",
    envUserKey: "SNS_USERNAME_X",
    envPassKey: "SNS_PASSWORD_X",
  },
  {
    name: "instagram",
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    domains: ["instagram.com", ".instagram.com"],
    loggedInSelector: 'svg[aria-label="新規投稿"], svg[aria-label="New post"], a[href*="/direct/"]',
    usernameSelector: 'input[name="username"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    codeInputSelector: 'input[name="verificationCode"], input[autocomplete="one-time-code"]',
    gmailService: "instagram",
    envUserKey: "SNS_USERNAME_IG",
    envPassKey: "SNS_PASSWORD_IG",
  },
  {
    name: "tiktok",
    label: "TikTok",
    loginUrl: "https://www.tiktok.com/login/phone-or-email/email",
    domains: ["tiktok.com", ".tiktok.com"],
    loggedInSelector: 'a[href*="/upload"], button[data-e2e="upload-icon"], a[href*="/tiktokstudio"]',
    usernameSelector: 'input[name="username"], input[autocomplete="email"], input[autocomplete="username"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"], button[data-e2e="login-button"]',
    codeInputSelector: 'input[autocomplete="one-time-code"], input[placeholder*="コード"], input[placeholder*="code"]',
    gmailService: "tiktok",
    envUserKey: "SNS_USERNAME_TIKTOK",
    envPassKey: "SNS_PASSWORD_TIKTOK",
  },
];

async function main() {
  const outDir = path.join(os.homedir(), ".config", "dailyworld60");
  await fs.mkdir(outDir, { recursive: true });

  const aliases: Record<string, Site["name"]> = { ig: "instagram", tt: "tiktok" };
  const requested = process.argv.slice(2).map(a => aliases[a.toLowerCase()] ?? a.toLowerCase());
  const targets = requested.length === 0 ? SITES : SITES.filter(s => requested.includes(s.name));
  if (requested.length > 0 && targets.length === 0) {
    console.error(`Unknown site(s): ${requested.join(", ")}. Available: ${SITES.map(s => s.name).join(", ")}`);
    process.exit(1);
  }

  for (const site of targets) {
    console.log(`\n=== ${site.label} ===`);
    const profileDir = path.join(outDir, `profile-${site.name}`);
    await fs.mkdir(profileDir, { recursive: true });

    const ctx = await launchStealthContext(profileDir);
    try {
      const page = await ctx.newPage();
      const success = await loginFlow(page, site);
      if (!success) {
        console.warn(`[${site.name}] login flow ended without confirmation`);
      }
      await page.waitForTimeout(2000);

      const allCookies = await ctx.cookies();
      const filtered = allCookies.filter(c =>
        site.domains.some(d => c.domain === d || c.domain.endsWith(d)),
      );

      if (filtered.length === 0) {
        console.warn(`[${site.name}] 0 cookies extracted — login likely failed`);
      } else {
        const b64File = path.join(outDir, `${site.name}-cookies.b64`);
        const jsonFile = path.join(outDir, `${site.name}-cookies.json`);
        await fs.writeFile(b64File, Buffer.from(JSON.stringify(filtered)).toString("base64"), "utf-8");
        await fs.writeFile(jsonFile, JSON.stringify(filtered, null, 2), "utf-8");
        console.log(`[${site.name}] saved ${filtered.length} cookies -> ${b64File}`);
      }
    } catch (e) {
      console.error(`[${site.name}] failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      try { await ctx.close(); } catch { /* ignore */ }
    }
  }

  console.log("\n=== ALL DONE ===");
  console.log(`Files: ${outDir}/`);
  console.log("");
  console.log("GitHub Secrets 登録コマンド:");
  for (const s of targets) {
    const key = s.name === "x" ? "X" : s.name.toUpperCase();
    console.log(`  gh secret set ${key}_COOKIES_B64 --body "$(cat ${outDir}/${s.name}-cookies.b64)" --repo HeroCramSchool/daily-world-60`);
  }
}

async function loginFlow(page: Page, site: Site): Promise<boolean> {
  await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  if (await isLoggedIn(page, site)) {
    console.log(`[${site.name}] already logged in (cookies still valid)`);
    return true;
  }

  const user = process.env[site.envUserKey];
  const pass = process.env[site.envPassKey];

  if (!user || !pass) {
    console.log(`[${site.name}] 認証情報なし — ブラウザで手動ログインしてください（最大 15 分待機）`);
    await page.waitForSelector(site.loggedInSelector, { timeout: 900_000 });
    return true;
  }

  console.log(`[${site.name}] 自動ログイン試行 (${user.slice(0, 4)}***)`);

  if (site.usernameSelector) {
    await humanType(page, site.usernameSelector, user);
    await page.waitForTimeout(800);
  }

  if (site.name === "x") {
    const nextBtn = page.getByRole("button", { name: /next|次へ/i }).first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    }
  }

  if (site.passwordSelector) {
    await humanType(page, site.passwordSelector, pass);
    await page.waitForTimeout(500);
  }

  if (site.submitSelector) {
    await page.locator(site.submitSelector).first().click().catch(() => {});
  }

  for (let i = 0; i < 30; i++) {
    if (await isLoggedIn(page, site)) {
      console.log(`[${site.name}] logged in`);
      return true;
    }
    if (await tryAutoSolveCaptcha(page)) {
      console.log(`[${site.name}] CAPTCHA auto-solved`);
      await page.waitForTimeout(2000);
      continue;
    }
    if (site.codeInputSelector && (await page.locator(site.codeInputSelector).first().isVisible().catch(() => false))) {
      console.log(`[${site.name}] code input detected, fetching from Gmail...`);
      try {
        const code = await getVerificationCode(site.gmailService);
        await humanType(page, site.codeInputSelector, code);
        await page.waitForTimeout(500);
        await page.keyboard.press("Enter");
      } catch (e) {
        console.warn(`[${site.name}] Gmail code fetch failed: ${e instanceof Error ? e.message : e}`);
      }
      await page.waitForTimeout(3000);
      continue;
    }
    await page.waitForTimeout(1500);
  }

  return await isLoggedIn(page, site);
}

async function isLoggedIn(page: Page, site: Site): Promise<boolean> {
  return await page.locator(site.loggedInSelector).first().isVisible().catch(() => false);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
