import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * 各動画ごとに X (日本語) 用ツイートを生成する (v10)。
 *
 * 出力: output/YYYY-MM-DD/x-thread.txt
 *   1 動画 = 1 ツイート (短く、リンクなし)
 *   日本語のみ、AI 臭除去ルール準拠
 *
 * 投稿は 3 ツイート別の独立した投稿 (スレッドではなく、個別ツイート 3 本)。
 */

interface Country { code: string; flag: string; name?: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  keyword?: { word: string; definitionEn: string };
}
interface ScriptJsonEn {
  date: string;
  stories: Story[];
}
interface ScriptJsonJp {
  date: string;
  stories: Story[];
}

// CD/KW/SG 用の日本語要約（既に script-jp.json にあるもの）
async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const en: ScriptJsonEn = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));
  const jp: ScriptJsonJp = JSON.parse(await fs.readFile(path.join(dir, "script-jp.json"), "utf-8"));
  const mmdd = date.slice(5).replace("-", "/");

  const lines: string[] = [];
  lines.push(`# Daily World 60 — ${date} X 投稿用 (3 本独立ツイート)`);
  lines.push(`# 各ツイートは独立投稿。スレッド可。動画 (news-N-{code}.mp4) と一緒に投稿。`);
  lines.push(``);

  for (const enStory of en.stories) {
    const jpStory = jp.stories.find(s => s.country.code === enStory.country.code);
    if (!jpStory) continue;

    const tweet =
      `🌍 ${mmdd} 世界ニュース\n` +
      `${jpStory.country.flag} ${jpStory.headline}\n` +
      `\n` +
      `${jpStory.summary}\n` +
      `\n` +
      `今日の英単語: ${enStory.keyword?.word ?? ""}\n` +
      `\n` +
      `出典: ${jpStory.sourceName}\n` +
      `#DailyWorld60 #世界ニュース #英語学習`;

    const charCount = [...tweet].length;
    const flag = charCount > 140 ? " ⚠ OVER 140 — 要短縮" : "";
    lines.push(`--- ツイート ${enStory.index}/3 (${jpStory.country.code}, ${charCount}字)${flag} ---`);
    lines.push(`動画: news-${enStory.index}-${enStory.country.code.toLowerCase()}.mp4`);
    lines.push(tweet);
    lines.push(``);
  }

  // AI 臭チェック
  const NG = ["いかがでしたか", "ぜひ", "ご紹介", "することができます", "と考えられます", "結論として", "まとめると"];
  const allText = lines.join("\n");
  const hits = NG.filter(p => allText.includes(p));
  if (hits.length > 0) {
    lines.push(`# ⚠ AI-smell: ${hits.join(", ")}`);
  } else {
    lines.push(`# ✓ AI-smell check passed`);
  }

  const outFile = path.join(dir, "x-thread.txt");
  await fs.writeFile(outFile, lines.join("\n"), "utf-8");
  console.log(`[x] wrote ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
