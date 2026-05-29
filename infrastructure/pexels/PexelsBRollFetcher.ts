import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BRollClip,
  BRollFetcherPort,
} from "../../application/ports/BRollFetcherPort.js";

interface PexelsVideo {
  id: number;
  duration: number;
  video_files: Array<{
    link: string;
    quality: string;
    width: number;
    height: number;
    file_type: string;
  }>;
}

interface PexelsSearchResponse {
  videos: PexelsVideo[];
}

const API = "https://api.pexels.com/videos/search";

/**
 * Pexels Videos API（無料・登録のみ）で B-roll を取得。
 */
export class PexelsBRollFetcher implements BRollFetcherPort {
  constructor(private readonly apiKey: string) {}

  async fetch(input: {
    query: string;
    minDurationSeconds: number;
    outputPath: string;
  }): Promise<BRollClip> {
    if (!this.apiKey) throw new Error("PEXELS_API_KEY missing");

    const url = `${API}?query=${encodeURIComponent(input.query)}&per_page=10&orientation=portrait`;
    const res = await fetch(url, { headers: { Authorization: this.apiKey } });
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    const json = (await res.json()) as PexelsSearchResponse;
    const candidate = json.videos.find(v => v.duration >= input.minDurationSeconds);
    if (!candidate) {
      throw new Error(`No Pexels clip matched query="${input.query}"`);
    }
    const file =
      candidate.video_files.find(f => f.quality === "hd" && f.width <= 1080) ??
      candidate.video_files[0];

    await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
    const video = await fetch(file.link);
    if (!video.ok || !video.body) throw new Error(`Pexels download failed`);
    const buf = Buffer.from(await video.arrayBuffer());
    await fs.writeFile(input.outputPath, buf);

    return {
      filePath: input.outputPath,
      durationSeconds: candidate.duration,
      query: input.query,
    };
  }
}
