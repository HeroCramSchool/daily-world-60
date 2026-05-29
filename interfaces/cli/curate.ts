import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildContainer } from "./container.js";
import { DEFAULT_CURATION_CRITERIA } from "../../domain/news/NewsCurationCriteria.js";
import type { NewsArticle } from "../../domain/news/NewsArticle.js";

async function main() {
  const c = await buildContainer();
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(c.outputRoot, date);

  // articles.json を読み込む。なければ fetch から実行。
  const articlesFile = path.join(outDir, "articles.json");
  let articles: NewsArticle[];
  try {
    const raw = JSON.parse(await fs.readFile(articlesFile, "utf-8"));
    articles = raw.map((a: NewsArticle & { publishedAt: string }) => ({
      ...a,
      publishedAt: new Date(a.publishedAt),
    }));
    console.log(`[curate] loaded ${articles.length} from ${articlesFile}`);
  } catch {
    console.log(`[curate] articles.json not found, running fetch first`);
    articles = await c.fetchNews.execute({
      sources: c.sources,
      options: { sinceHours: 24, perSourceLimit: 8 },
    });
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(articlesFile, JSON.stringify(articles, null, 2), "utf-8");
  }

  console.log(`[curate] calling Claude API for Top 3 selection + ESL script...`);
  const script = await c.curate.execute({
    articles,
    criteria: DEFAULT_CURATION_CRITERIA,
    date,
  });

  const file = path.join(outDir, "script-en.json");
  await fs.writeFile(file, JSON.stringify(script, null, 2), "utf-8");
  console.log(`[curate] saved -> ${file}\n`);

  // プレビュー
  console.log("=== EN Script Preview ===");
  console.log(`Hook: ${script.hook}\n`);
  for (const s of script.stories) {
    console.log(`${s.index}. ${s.country.flag} ${s.headline}`);
    console.log(`   ${s.summary}`);
    console.log(`   Source: ${s.sourceName} (${s.sourceUrl})\n`);
  }
  console.log(`Today's word: ${script.todaysWord.word} = ${script.todaysWord.definitionEn}`);
  console.log(`Close: ${script.close}`);

  console.log(`\n[curate] now translating to Japanese for X...`);
  const jp = await c.translate.execute(script);
  const jpFile = path.join(outDir, "script-jp.json");
  await fs.writeFile(jpFile, JSON.stringify(jp, null, 2), "utf-8");
  console.log(`[curate] saved -> ${jpFile}\n`);

  console.log("=== JP X Thread Preview ===");
  const { Script } = await import("../../domain/script/Script.js");
  const tweets = Script.toXThread(jp);
  for (let i = 0; i < tweets.length; i++) {
    console.log(`--- Tweet ${i + 1}/${tweets.length} (${tweets[i].length}字) ---`);
    console.log(tweets[i]);
    console.log();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
