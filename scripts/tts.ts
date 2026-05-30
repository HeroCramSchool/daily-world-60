import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Script } from "../domain/script/Script.js";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const outDir = path.join("output", date);
  const scriptFile = path.join(outDir, "script-en.json");
  const audioFile = path.join(outDir, "voice.mp3");
  const subFile = path.join(outDir, "voice.vtt");

  const script = JSON.parse(await fs.readFile(scriptFile, "utf-8"));
  const narration = Script.toNarration(script);

  console.log(`[tts] generating narration (${narration.split(/\s+/).length} words)`);

  const voice = process.env.EN_VOICE ?? "en-US-AvaNeural";
  await run("edge-tts", [
    "--voice", voice,
    "--rate", "+5%",
    "--pitch", "+0Hz",
    "--text", narration,
    "--write-media", audioFile,
    "--write-subtitles", subFile,
  ]);

  const stat = await fs.stat(audioFile);
  console.log(`[tts] done: ${audioFile} (${stat.size} bytes)`);
  const sstat = await fs.stat(subFile);
  console.log(`[tts] done: ${subFile} (${sstat.size} bytes)`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
