import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishYoutube } from "./publishers/youtube.js";
import { bgmCredit, readBgmUsed } from "./lib/bgm-credit.js";

/**
 * output/YYYY-MM-DD/longform.mp4 を YouTube(長尺)へ投稿する。
 * 概要欄に章タイムスタンプ・出典・CC-BY 音楽帰属・disclaimer を入れる。
 */
interface Source { name: string; url: string; }
interface Section { heading: string; sources?: Source[]; }
interface Longform {
  date: string; title: string; topic?: string; sections: Section[];
  todaysWord?: { word: string }; sourceUrls?: string[];
}
interface Chapter { heading: string; start: number; }

function ts(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = process.env.OUT_DIR ?? path.join("output", date);
  const lf: Longform = JSON.parse(await fs.readFile(path.join(dir, "longform.json"), "utf-8"));
  const videoPath = path.join(dir, "longform.mp4");
  await fs.access(videoPath);

  let chapters: Chapter[] = [];
  try {
    chapters = (JSON.parse(await fs.readFile(path.join(dir, "longform-chapters.json"), "utf-8")).chapters) ?? [];
  } catch { /* no chapters */ }

  const lines: string[] = [lf.title, ""];
  if (chapters.length) {
    lines.push("Chapters:");
    for (const c of chapters) lines.push(`${ts(c.start)} ${c.heading}`);
    lines.push("");
  }
  const urls = (lf.sourceUrls && lf.sourceUrls.length)
    ? lf.sourceUrls
    : lf.sections.flatMap(s => (s.sources ?? []).map(x => x.url)).filter(Boolean);
  if (urls.length) {
    lines.push("Sources:");
    for (const u of [...new Set(urls)]) lines.push(u);
    lines.push("");
  }
  lines.push(
    `${date} · Daily World 60 — Weekly Deep Dive`,
    "A deeper look at one big story, every week. Subscribe for more.",
    "",
    "Educational summary · Fair use (US §107 / JP 著作権法32条). AI-assisted voice and video editing.",
  );
  const lfBgm = await readBgmUsed(dir, "longform");
  if (lfBgm) lines.push("", ...bgmCredit(lfBgm));
  const description = lines.join("\n");

  const tags = [
    "World News", "Deep Dive", "Explainer", "News Analysis", "Daily World 60", "World News Explained",
    ...(lf.topic ? [lf.topic] : []),
    ...(lf.todaysWord ? [lf.todaysWord.word] : []),
  ];

  const sizeMb = ((await fs.stat(videoPath)).size / 1024 / 1024).toFixed(1);
  console.log(`[longform-publish] uploading "${lf.title}" (${sizeMb} MB)`);
  const res = await publishYoutube({ videoPath, title: lf.title, description, tags });
  await fs.writeFile(path.join(dir, "longform-publish-result.json"), JSON.stringify(res, null, 2), "utf-8");
  console.log("[longform-publish]", JSON.stringify(res));
  if (!(res as { ok?: boolean }).ok) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
