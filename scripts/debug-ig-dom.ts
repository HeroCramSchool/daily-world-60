import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeCookies } from "./publishers/cookie-util.js";
import { launchStealthContext } from "./auth/captcha/stealth-context.js";
import { sleep, humanClick } from "./auth/captcha/human-mouse.js";

/**
 * 「新しい投稿作成」クリック後に現れるサブメニューの実 DOM を網羅ダンプする。
 * a[role=link] 以外 (div[role=button], [role=menuitem], svg[aria-label] 等) も含めて
 * 可視なインタラクティブ要素を列挙し、'投稿'/'リール' の本当の要素型を特定する。投稿はしない。
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
  for (const sel of ['button:has-text("後で")', 'button:has-text("あとで")', 'button:has-text("Not Now")']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanClick(page, el);
      await sleep(1500);
      break;
    }
  }

  const beforeInputs = await page.locator('input[type="file"]').count();
  console.log(`[dbg] file inputs before create click: ${beforeInputs}`);

  console.log("[dbg] clicking 新しい投稿作成 ...");
  const createBtn = page.locator('a[role="link"]:has-text("新しい投稿作成"), svg[aria-label="新しい投稿作成"]').first();
  await humanClick(page, createBtn);
  await sleep(6000);
  console.log(`[dbg] url after create: ${page.url()}`);
  console.log(`[dbg] file inputs after create click: ${await page.locator('input[type="file"]').count()}`);

  // 可視なインタラクティブ要素を全部ダンプ
  const dump = await page.evaluate(() => {
    const sel = 'a,button,[role="button"],[role="menuitem"],[role="link"],svg[aria-label],div[tabindex],span[role]';
    const out: Array<Record<string, string>> = [];
    for (const node of Array.from(document.querySelectorAll(sel))) {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue; // 非表示
      const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const aria = el.getAttribute("aria-label") || "";
      if (!text && !aria) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        aria,
        href: el.getAttribute("href") || "",
        text,
      });
    }
    return out;
  });

  console.log("\n[dbg] ===== visible interactive elements =====");
  for (const e of dump) {
    if (/投稿|リール|Post|Reel|computer|コンピュータ|選択|Select/i.test(e.text + e.aria)) {
      console.log(`  >>> tag=${e.tag} role="${e.role}" aria="${e.aria}" href="${e.href}" text="${e.text}"`);
    }
  }
  console.log("\n[dbg] ----- (all, compact) -----");
  for (const e of dump) {
    console.log(`  tag=${e.tag} role="${e.role}" aria="${e.aria}" text="${e.text}"`);
  }

  // 「投稿」を含む要素の周辺 HTML を採取
  const html = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('a,button,[role="button"],[role="menuitem"],span,div'))
      .find(n => (n.textContent || "").trim() === "投稿" || (n.textContent || "").trim() === "リール");
    if (!hit) return "(no exact 投稿/リール element found)";
    let cur: Element | null = hit;
    for (let i = 0; i < 3 && cur?.parentElement; i++) cur = cur.parentElement;
    return (cur as HTMLElement)?.outerHTML?.slice(0, 1500) ?? "";
  });
  console.log("\n[dbg] ===== HTML around 投稿/リール =====\n" + html);

  await page.screenshot({ path: "/tmp/ig-create-menu.png" }).catch(() => {});
  console.log("\n[dbg] screenshot → /tmp/ig-create-menu.png");

  // === FULL FLOW TEST: 投稿項目 → 直接 setInputFiles → Next 画面の DOM を採取 ===
  console.log("\n[dbg] FLOW: click 投稿 item");
  const postItem = page.locator('a[role="link"][href="#"]:has(svg[aria-label="投稿"])').first();
  if (await postItem.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanClick(page, postItem);
    await sleep(5000);
    const fi = page.locator('input[type="file"], input[accept*="video"]').first();
    console.log(`[dbg] fileInputs after post: ${await page.locator('input[type="file"]').count()}`);
    // 直接 setInputFiles (ボタンクリック/filechooser を経由しない)
    try {
      await fi.setInputFiles("/tmp/dw60-art2/news-1-lb.mp4");
      console.log("[dbg] setInputFiles OK (direct)");
    } catch (e) {
      console.log(`[dbg] direct setInputFiles failed: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(9000); // 動画処理待ち
    // Next 画面の buttons / dialog を dump
    const after = await page.evaluate(() => {
      const out: string[] = [];
      for (const n of Array.from(document.querySelectorAll('button,[role="button"],div[role="dialog"] *'))) {
        const el = n as HTMLElement;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
        const a = el.getAttribute("aria-label") || "";
        if (/次へ|Next|シェア|Share|トリミング|crop|キャプション|caption|コンピュータ|選択/i.test(t + a)) {
          out.push(`${el.tagName.toLowerCase()} role="${el.getAttribute("role") || ""}" aria="${a}" text="${t}"`);
        }
      }
      return [...new Set(out)];
    });
    console.log("[dbg] ===== post-file DOM (Next/Share/crop/caption) =====");
    for (const l of after) console.log("  " + l);
    await page.screenshot({ path: "/tmp/ig-after-file.png" }).catch(() => {});
    console.log("[dbg] screenshot → /tmp/ig-after-file.png");
  } else {
    console.log("[dbg] post item NOT visible");
  }
  await sleep(3000);
  await ctx.close();
}

main().catch(e => { console.error(e); process.exit(1); });
