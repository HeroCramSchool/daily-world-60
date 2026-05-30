import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * X (Twitter) 用スレッドを文字だけで生成する。
 * AI-smell-removal ガイド (~/.company/marketing/ai-smell-removal-guide.md) 準拠:
 *   - 「いかがでしたか」「ご紹介」「することができます」「3つのポイント」NG
 *   - 文末を3連続同一にしない (です/ます/だ/である 混ぜる)
 *   - em-dash (—) 禁止
 *   - 数字・固有名詞・地名を必ず入れる
 *   - 各ツイート ≤140 字
 *
 * 構成 (5 tweets):
 *   1. Hook: 日付 + ハッシュタグ
 *   2-4. Story 1-3: 国旗 + 見出し + 要約 + 出典
 *   5. 締め: today's word + 動画誘導
 */

interface Story {
  index: number;
  country: { code: string; flag: string };
  headline: string;
  summary: string;
  sourceName: string;
}
interface Script {
  date: string;
  stories: Story[];
  todaysWord: { word: string; definitionJp: string };
}

function countChars(s: string): number {
  // X の文字数カウントは emoji を 2 文字相当でカウントするが、簡易版として js length。
  return [...s].length;
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: Script = JSON.parse(await fs.readFile(path.join(dir, "script-jp.json"), "utf-8"));
  const mmdd = date.slice(5).replace("-", "/");

  const tweets: string[] = [];

  // Tweet 1: hook
  tweets.push(
    `🌍 ${mmdd}の世界ニュース、3本。\n` +
    `60秒の英語動画と一緒に流します。\n` +
    `#DailyWorld60 #世界ニュース`
  );

  // Tweet 2-4: stories
  script.stories.forEach((st) => {
    const summary = st.summary.length > 75 ? st.summary.slice(0, 74) + "…" : st.summary;
    tweets.push(
      `${st.country.flag} ${st.headline}\n` +
      `\n` +
      `${summary}\n` +
      `\n` +
      `出典: ${st.sourceName}`
    );
  });

  // Tweet 5: today's word + CTA
  tweets.push(
    `今日の英単語: "${script.todaysWord.word}" = ${script.todaysWord.definitionJp}\n` +
    `\n` +
    `英語版60秒動画は YouTube / TikTok / Instagram @60dailyworld で配信中。\n` +
    `毎朝、世界の3本だけ。`
  );

  // Output as txt with index + char count
  const lines: string[] = [];
  lines.push(`# Daily World 60 — X スレッド (${date})`);
  lines.push(`# 各ツイートは 140 字以内。順番に投稿。`);
  lines.push("");
  tweets.forEach((t, i) => {
    const chars = countChars(t);
    const flag = chars > 140 ? " ⚠ OVER 140" : "";
    lines.push(`--- Tweet ${i + 1}/5 (${chars} chars)${flag} ---`);
    lines.push(t);
    lines.push("");
  });

  const outFile = path.join(dir, "x-thread.txt");
  await fs.writeFile(outFile, lines.join("\n"), "utf-8");
  console.log(`[x] wrote ${outFile} (${tweets.length} tweets)`);

  // AI-smell check
  const NG_PHRASES = [
    "いかがでしたか",
    "ぜひ",
    "ご紹介",
    "することができます",
    "と考えられます",
    "結論として",
    "まとめると",
    "3つのポイント",
    "3つのコツ",
  ];
  const all = tweets.join("\n");
  const hits = NG_PHRASES.filter(p => all.includes(p));
  if (hits.length > 0) {
    console.warn(`[x] ⚠ AI-smell phrases: ${hits.join(", ")}`);
  } else {
    console.log("[x] ✓ AI-smell check passed");
  }
  if (all.includes("—")) {
    console.warn("[x] ⚠ em-dash found");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
