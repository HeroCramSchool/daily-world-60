/**
 * 解説形式で事実の出典にしてよい報道機関。web_search / web_fetch の allowed_domains と checkFacts の allowedHosts に同じものを渡す。
 * 国営の宣伝媒体（TASS・Xinhua・Press TV・RT・Global Times・KCNA など）は入れない。
 * Anthropic のクローラーを断っている媒体も入れない。allowed_domains に1つでも入ると呼び出し全体が 400 になる
 * （2026-11-01 に確認。断っていたのは apnews.com・reuters.com・bbc.com・bbc.co.uk・theguardian.com・nytimes.com・
 * dw.com・ft.com・independent.co.uk・lemonde.fr・news.sky.com・nhk.or.jp・politico.com・politico.eu・rfi.fr・
 * straitstimes.com・thehindu.com・wsj.com・yna.co.kr）。断っている媒体のページを自前の HTTP で取って渡すこともしない。
 */
export const OUTLETS: readonly string[] = [
  "aljazeera.com", "washingtonpost.com", "cnn.com", "npr.org", "cbsnews.com", "nbcnews.com",
  "abcnews.go.com", "france24.com", "euronews.com", "kyivindependent.com", "pravda.com.ua", "ukrinform.net",
  "timesofisrael.com", "haaretz.com", "jpost.com", "axios.com", "bloomberg.com", "scmp.com",
  "japantimes.co.jp", "abc.net.au", "cbc.ca",
];

export function hostOf(url: string): string | null {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** URL のホストが一覧のどれかと同じか、そのサブドメイン（checkFacts と同じ規則）。 */
export function isAllowedUrl(url: string, hosts: readonly string[] = OUTLETS): boolean {
  const host = hostOf(url);
  return !!host && hosts.some(h => host === h || host.endsWith(`.${h}`));
}
