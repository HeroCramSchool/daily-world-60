import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Script } from "../domain/script/Script.js";

/**
 * 各ストーリーごとに個別の voice mp3 + vtt を生成する。
 *
 * 入力:  output/YYYY-MM-DD/script-en.json
 * 出力:  voice-{code}.mp3, voice-{code}.vtt  (code: cd / kw / sg / ...)
 */

interface Country { code: string; flag: string; name?: string; }
interface Keyword { word: string; definitionEn: string; }
interface Story {
  index: number;
  country: Country;
  headline: string;
  summary: string;
  sourceName: string;
  keyword?: Keyword;
}
interface ScriptJson {
  date: string;
  stories: Story[];
  todaysWord: { word: string; definitionEn: string; definitionJp: string };
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script: ScriptJson = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  const voice = process.env.EN_VOICE ?? "en-US-AvaNeural";

  for (const story of script.stories) {
    const code = story.country.code.toLowerCase();
    const mp3 = path.join(dir, `voice-${code}.mp3`);
    const vtt = path.join(dir, `voice-${code}.vtt`);

    const narration = Script.toStoryNarration(story);
    console.log(`[tts] ${code}: ${narration.split(/\s+/).length} words`);

    await run("edge-tts", [
      "--voice", voice,
      "--rate=-12%",
      "--pitch=+0Hz",
      "--text", narration,
      "--write-media", mp3,
      "--write-subtitles", vtt,
    ]);

    const stat = await fs.stat(mp3);
    console.log(`[tts] ${code} → ${mp3} (${(stat.size / 1024).toFixed(0)} KB)`);
  }
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
