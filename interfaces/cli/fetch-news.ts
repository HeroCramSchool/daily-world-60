import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildContainer } from "./container.js";

async function main() {
  const c = await buildContainer();
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(c.outputRoot, date);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`[fetch-news] sources=${c.sources.length} date=${date}`);
  const articles = await c.fetchNews.execute({
    sources: c.sources,
    options: { sinceHours: 24, perSourceLimit: 8 },
  });
  console.log(`[fetch-news] fetched ${articles.length} articles`);

  const file = path.join(outDir, "articles.json");
  await fs.writeFile(file, JSON.stringify(articles, null, 2), "utf-8");
  console.log(`[fetch-news] saved -> ${file}`);

  // 地域別の件数だけプレビュー
  const byRegion = new Map<string, number>();
  for (const a of articles) {
    byRegion.set(a.source.region, (byRegion.get(a.source.region) ?? 0) + 1);
  }
  console.log("[fetch-news] by region:");
  for (const [r, n] of byRegion) console.log(`  ${r}: ${n}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
