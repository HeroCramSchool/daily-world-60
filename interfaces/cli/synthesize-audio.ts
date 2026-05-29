import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildContainer } from "./container.js";
import type { Script } from "../../domain/script/Script.js";

async function main() {
  const c = await buildContainer();
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(c.outputRoot, date);

  const scriptFile = path.join(outDir, "script-en.json");
  const script: Script = JSON.parse(await fs.readFile(scriptFile, "utf-8"));

  const mp3 = path.join(outDir, "voice.mp3");
  console.log(`[tts] synthesizing -> ${mp3}`);
  const audio = await c.synthesizeAudio.execute({ script, outputPath: mp3 });
  console.log(`[tts] done. ~${audio.durationSeconds}s estimated`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
