import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext } from "playwright";

const stealth = StealthPlugin();
// stealth は puppeteer 系 evasion を使うが、playwright-extra 経由で多くは動く
chromium.use(stealth);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Profile dir に残った Chromium の SingletonLock を掃除する。
 * 前回 run が異常終了した場合、これらが残って次回 launch が失敗する。
 * Playwright #35466 で議論されている既知の問題への予防策。
 */
export async function cleanProfileLocks(profileDir: string): Promise<void> {
  const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  for (const f of lockFiles) {
    await fs.rm(path.join(profileDir, f), { force: true }).catch(() => { /* ignore */ });
  }
}

export async function launchStealthContext(profileDir: string): Promise<BrowserContext> {
  // 起動前に古い lock を掃除
  await cleanProfileLocks(profileDir);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
    locale: "ja-JP",
    timezoneId: "Pacific/Auckland",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-infobars",
      "--disable-features=IsolateOrigins,site-per-process",
      // GH Actions ubuntu-latest 非特権コンテナで Chrome を安定起動させる必須フラグ
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Additional fingerprint masking
  await ctx.addInitScript(() => {
    // Hide webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["ja-JP", "ja", "en-US", "en"],
    });

    // Plugins (non-empty)
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "PDF Viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", description: "Portable Document Format" },
        { name: "Chromium PDF Viewer", description: "Portable Document Format" },
        { name: "Microsoft Edge PDF Viewer", description: "Portable Document Format" },
        { name: "WebKit built-in PDF", description: "Portable Document Format" },
      ],
    });

    // Permissions API (notifications should be "default" not "denied")
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: PermissionDescriptor) => {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "default" } as unknown as PermissionStatus);
      }
      return origQuery(params);
    };

    // WebGL fingerprint nudge
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
      if (parameter === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParam.call(this, parameter);
    };

    // Chrome runtime
    interface ChromeWindow extends Window { chrome?: { runtime?: object } }
    (window as ChromeWindow).chrome = (window as ChromeWindow).chrome ?? { runtime: {} };
  });

  return ctx;
}
