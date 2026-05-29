import { buildContainer } from "./container.js";
import { DEFAULT_CURATION_CRITERIA } from "../../domain/news/NewsCurationCriteria.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipAudio = args.includes("--skip-audio");
  const skipPublish = args.includes("--skip-publish") || dryRun;

  const c = await buildContainer();

  console.log(`[pipeline] sources=${c.sources.length}`);
  console.log(`[pipeline] options: dryRun=${dryRun} skipAudio=${skipAudio} skipPublish=${skipPublish}`);

  const result = await c.runPipeline.execute({
    sources: c.sources,
    criteria: DEFAULT_CURATION_CRITERIA,
    outputRoot: c.outputRoot,
    skipAudio,
    skipPublish,
    dryRun,
  });

  console.log(`\n[pipeline] DONE`);
  console.log(`  date:      ${result.date}`);
  console.log(`  outputDir: ${result.outputDir}`);
  console.log(`  stories:   ${result.enScript.stories.length}`);
  if (result.publishResults) {
    for (const r of result.publishResults as Array<{ platform: string; ok: boolean; error?: string; draft?: boolean }>) {
      const status = r.ok ? "OK" : `FAIL: ${r.error}`;
      console.log(`  ${r.platform}: ${status}${r.draft ? " (draft)" : ""}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
