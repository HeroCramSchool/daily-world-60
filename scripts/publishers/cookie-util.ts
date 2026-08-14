import type { Cookie } from "playwright";

/**
 * Cookie-Editor / Playwright 両フォーマットを Playwright が受け入れる形に正規化する。
 *
 * Cookie-Editor:
 *   { expirationDate?: number, sameSite: "no_restriction"|"lax"|"strict"|null, hostOnly, storeId, ... }
 * Playwright:
 *   { expires?: number, sameSite: "None"|"Lax"|"Strict", ... }
 */
export function normalizeCookies(raw: Array<Record<string, unknown>>): Cookie[] {
  return raw.map(c => {
    const cookie: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: (c.path as string) ?? "/",
      httpOnly: (c.httpOnly as boolean) ?? false,
      secure: (c.secure as boolean) ?? false,
    };

    const expires =
      (c.expirationDate as number | undefined) ??
      (c.expires as number | undefined);
    if (typeof expires === "number") cookie.expires = expires;

    const ss = c.sameSite;
    if (ss === "no_restriction" || ss === "None") cookie.sameSite = "None";
    else if (ss === "lax" || ss === "Lax") cookie.sameSite = "Lax";
    else if (ss === "strict" || ss === "Strict") cookie.sameSite = "Strict";
    // null / unstrict / "unspecified" → 省略（Playwright がデフォルト適用）

    return cookie as unknown as Cookie;
  });
}

/**
 * Base64 → JSON → normalized cookies の一括処理。
 */
export function decodeCookies(b64: string): Cookie[] {
  const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  return normalizeCookies(json);
}
