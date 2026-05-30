import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";

/**
 * 3つの SNS (X / Instagram / TikTok) の Cookie を1ブラウザ起動で順番に取得し、
 * base64 化して ~/.config/dailyworld60/ に書き出す。
 *
 * 使い方:
 *   npx tsx scripts/auth/get-sns-cookies.ts
 *
 * 起動するとブラウザが開く。各 SNS のログイン画面が順次表示されるので
 * @60dailyworld でログインしてください。ログイン完了を検知したら次へ自動遷移。
 */

interface Site {
  name: "x" | "instagram" | "tiktok";
  label: string;
  loginUrl: string;
  loggedInUrl: string;        // ログイン後の典型 URL
  domains: string[];          // Cookie を抜くドメイン
  checkSelector: string;      // ログイン完了の判定セレクタ
}

const SITES: Site[] = [
  {
    name: "x",
    label: "X (Twitter)",
    loginUrl: "https://x.com/login",
    loggedInUrl: "https://x.com/home",
    domains: ["x.com", ".x.com", "twitter.com", ".twitter.com"],
    checkSelector: 'a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]',
  },
  {
    name: "instagram",
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    loggedInUrl: "https://www.instagram.com/",
    domains: ["instagram.com", ".instagram.com"],
    checkSelector: 'svg[aria-label="新規投稿"], svg[aria-label="New post"], a[href*="/direct/"]',
  },
  {
    name: "tiktok",
    label: "TikTok",
    loginUrl: "https://www.tiktok.com/login",
    loggedInUrl: "https://www.tiktok.com/foryou",
    domains: ["tiktok.com", ".tiktok.com"],
    checkSelector: 'a[href*="/upload"], button[data-e2e="upload-icon"]',
  },
];

async function main() {
  const outDir = path.join(process.env.HOME ?? "", ".config", "dailyworld60");
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    locale: "ja-JP",
  });

  for (const site of SITES) {
    console.log(`\n=== ${site.label} ===`);
    console.log(`ブラウザで @60dailyworld でログインしてください。`);
    console.log(`完了したらこのターミナルに戻って Enter を押すか、自動検知を待ってください。`);

    const page = await context.newPage();
    await page.goto(site.loginUrl);

    // ログイン完了を検知（最大10分）
    const result = await Promise.race([
      page
        .waitForSelector(site.checkSelector, { timeout: 600_000 })
        .then(() => "auto" as const),
      waitForKeypress().then(() => "manual" as const),
    ]).catch(() => "timeout" as const);

    console.log(`[${site.name}] login detected (${result})`);
    await page.waitForTimeout(1500);

    const allCookies = await context.cookies();
    const filtered = allCookies.filter(c =>
      site.domains.some(d => c.domain === d || c.domain.endsWith(d)),
    );

    const b64 = Buffer.from(JSON.stringify(filtered), "utf-8").toString("base64");
    const file = path.join(outDir, `${site.name}-cookies.b64`);
    await fs.writeFile(file, b64, "utf-8");

    const jsonFile = path.join(outDir, `${site.name}-cookies.json`);
    await fs.writeFile(jsonFile, JSON.stringify(filtered, null, 2), "utf-8");

    console.log(`[${site.name}] saved ${filtered.length} cookies -> ${file}`);
    console.log(`[${site.name}] (JSON copy at ${jsonFile})`);

    await page.close();
  }

  await context.close();
  await browser.close();

  console.log("\n=== ALL DONE ===");
  console.log(`Cookie files saved under ${outDir}`);
  console.log("");
  console.log("次のコマンドで GitHub Secrets に登録できます:");
  for (const s of SITES) {
    console.log(`  gh secret set ${s.name.toUpperCase()}_COOKIES_B64 --body "$(cat ${outDir}/${s.name}-cookies.b64)" --repo HeroCramSchool/daily-world-60`);
  }
}

function waitForKeypress(): Promise<void> {
  return new Promise(resolve => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve();
    });
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
