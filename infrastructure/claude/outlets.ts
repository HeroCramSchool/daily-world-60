/**
 * 解説形式で事実の出典にしてよい報道機関。web_search / web_fetch の allowed_domains と checkFacts の allowedHosts に同じものを渡す。
 * 国営の宣伝媒体（TASS・Xinhua・Press TV・RT・Global Times・KCNA など）は入れない。
 * Anthropic のクローラーを断っている媒体も入れない。allowed_domains に1つでも入ると呼び出し全体が 400 になる
 * （2026-11-01 に確認。断っていたのは apnews.com・reuters.com・bbc.com・bbc.co.uk・theguardian.com・nytimes.com・
 * dw.com・ft.com・independent.co.uk・lemonde.fr・news.sky.com・nhk.or.jp・politico.com・politico.eu・rfi.fr・
 * straitstimes.com・thehindu.com・wsj.com・yna.co.kr）。断っている媒体のページを自前の HTTP で取って渡すこともしない。
 * 400 にはならないが robots.txt で Claude-User・Claude-SearchBot を Disallow: / にしている媒体も入れない
 * （2026-11-01 の robots.txt。bloomberg.com・cnn.com・france24.com・haaretz.com・nbcnews.com・npr.org）。
 * web_fetch では取れず、出典がそこだと自前の HTTP で robots を迂回することになるため。
 */
export const OUTLETS: readonly string[] = [
  "aljazeera.com", "washingtonpost.com", "cbsnews.com", "abcnews.go.com", "euronews.com", "kyivindependent.com",
  "pravda.com.ua", "ukrinform.net", "timesofisrael.com", "jpost.com", "axios.com", "scmp.com",
  "japantimes.co.jp", "abc.net.au", "cbc.ca",
];

/** 画面の出典表示と YouTube の Sources: に出す名前。書き手の書いた名前は使わない。 */
export const OUTLET_NAMES: Readonly<Record<string, string>> = {
  "aljazeera.com": "Al Jazeera",
  "washingtonpost.com": "The Washington Post",
  "cbsnews.com": "CBS News",
  "abcnews.go.com": "ABC News",
  "euronews.com": "Euronews",
  "kyivindependent.com": "Kyiv Independent",
  "pravda.com.ua": "Ukrainska Pravda",
  "ukrinform.net": "Ukrinform",
  "timesofisrael.com": "The Times of Israel",
  "jpost.com": "The Jerusalem Post",
  "axios.com": "Axios",
  "scmp.com": "South China Morning Post",
  "japantimes.co.jp": "The Japan Times",
  "abc.net.au": "ABC News (Australia)",
  "cbc.ca": "CBC News",
};

export function hostOf(url: string): string | null {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const outletOf = (host: string, hosts: readonly string[]) => hosts.find(h => host === h || host.endsWith(`.${h}`));

/** URL のホストが一覧のどれかと同じか、そのサブドメイン（checkFacts と同じ規則）。 */
export function isAllowedUrl(url: string, hosts: readonly string[] = OUTLETS): boolean {
  const host = hostOf(url);
  return !!host && !!outletOf(host, hosts);
}

/** URL から媒体名を引く。一覧に無いホストはホスト名、読めない URL は空文字。 */
export function outletName(url: string): string {
  const host = hostOf(url);
  if (!host) return "";
  const key = outletOf(host, OUTLETS);
  return (key && OUTLET_NAMES[key]) || host;
}
