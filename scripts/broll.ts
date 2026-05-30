import * as fs from "node:fs/promises";
import * as path from "node:path";

const API = "https://api.pexels.com/videos/search";

interface PexelsVideo {
  id: number;
  duration: number;
  video_files: Array<{ link: string; quality: string; width: number; height: number; file_type: string }>;
}

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const outDir = path.join("output", date, "broll");
  await fs.mkdir(outDir, { recursive: true });

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("[broll] PEXELS_API_KEY not set — using fallback (single gray clip)");
    return; // 後段 ffmpeg が無ければ自前で色背景を生成
  }

  const script = JSON.parse(
    await fs.readFile(path.join("output", date, "script-en.json"), "utf-8"),
  );

  // Story ごとに 1 クリップ + intro/outro 用に 1 クリップ
  const queries: string[] = [
    "world map globe",
    ...script.stories.map((s: { country: { code: string } }) => `news ${s.country.code} city`),
    "earth space",
  ];

  let i = 0;
  for (const q of queries) {
    const out = path.join(outDir, `clip-${String(i + 1).padStart(2, "0")}.mp4`);
    try {
      await downloadPexels(apiKey, q, out);
      console.log(`[broll] ${i + 1}/${queries.length} ${q} -> ${out}`);
    } catch (e) {
      console.warn(`[broll] failed for "${q}": ${e instanceof Error ? e.message : e}`);
    }
    i++;
  }
}

async function downloadPexels(apiKey: string, query: string, outPath: string): Promise<void> {
  const url = `${API}?query=${encodeURIComponent(query)}&per_page=8&orientation=portrait`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const json = (await res.json()) as { videos: PexelsVideo[] };
  const candidate = json.videos.find(v => v.duration >= 8 && v.duration <= 30) ?? json.videos[0];
  if (!candidate) throw new Error("no clips");
  const file =
    candidate.video_files.find(f => f.quality === "hd" && f.width <= 1080) ??
    candidate.video_files[0];
  const v = await fetch(file.link);
  if (!v.ok) throw new Error(`download ${v.status}`);
  const buf = Buffer.from(await v.arrayBuffer());
  await fs.writeFile(outPath, buf);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
