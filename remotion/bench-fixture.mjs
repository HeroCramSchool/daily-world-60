import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * CI 実測用の合成素材。Drive も TTS も Commons も使わずに、本物と同じ形の
 * Short コンポジション (1080x1920 / 写真 12 枚 / 19 チャンク / 約 50 秒) を作る。
 * 目的は Remotion の CI コスト (npm install + Chrome 取得 + バンドル + レンダ) の測定。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, "public", "short");
mkdirSync(PUB, { recursive: true });

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const PHOTOS = 12;
for (let i = 1; i <= PHOTOS; i++) {
  const hue = Math.round((i / PHOTOS) * 360);
  // gradients の speed=0 は古い ffmpeg で範囲外エラーになる (CI 実測 2026-09-05)。
  // color + noise なら版を選ばない。
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", "color=c=0x1b2a4a:s=1080x1920",
    "-vf", `hue=h=${hue},noise=alls=18:allf=t+u,boxblur=2:1`,
    "-frames:v", "1", path.join(PUB, `photo-bench-${String(i).padStart(2, "0")}.jpg`)]);
}
// 無音のナレーション相当 (尺だけ本物に合わせる)
run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
  "-t", "50", "-c:a", "libmp3lame", "-q:a", "6", path.join(PUB, "voice-bench.mp3")]);

const words = (text, t0, dur) => {
  const ws = text.split(" ");
  const each = dur / ws.length;
  return ws.map((w, i) => ({ w, t: +(t0 + i * each).toFixed(3), d: +each.toFixed(3) }));
};

const SENTENCES = [
  "Officials confirmed the decision late", "on Tuesday after a long review",
  "The measure takes effect next month", "and covers about twelve million people",
  "Analysts expect the cost to rise", "before it settles again next year",
  "Local groups welcomed the announcement", "but asked for clearer timelines",
  "The department said it would publish", "the full guidance within two weeks",
  "Neighbouring states are watching closely", "and may follow with similar rules",
  "Funding remains the open question", "with no figure agreed so far",
  "A review is scheduled for spring", "and results will be made public",
  "Officials declined to comment further", "citing the ongoing consultation",
  "That is the situation for now",
];

let t = 8.0;
const chunks = SENTENCES.map((text, i) => {
  const dur = 1.9;
  const c = {
    text, start: +t.toFixed(3), end: +(t + dur).toFixed(3),
    words: words(text, t, dur),
    bg: `short/photo-bench-${String((i % PHOTOS) + 1).padStart(2, "0")}.jpg`,
    motion: null,
    firstOfCue: i % 2 === 0,
  };
  t += dur;
  return c;
});

const props = {
  date: "bench", fps: 30,
  videos: [{
    code: "bench", index: 1, accent: "#F5E63B",
    country: { name: "BENCHMARK", flag: null },
    headline: "A synthetic story used only to measure render cost in CI",
    hookText: "MEASURING RENDER COST", isShortHook: true,
    source: { name: "Bench", url: "example.com/bench" },
    audio: "short/voice-bench.mp3",
    bgm: null,
    duration: 50,
    hookEnd: 7.0,
    hookBg: "short/photo-bench-01.jpg",
    map: null,
    chunks,
    question: null,
    outro: { text: "And that is the end of the benchmark", start: +t.toFixed(3), end: 50 },
  }],
};
writeFileSync(path.join(HERE, "props-short.json"), JSON.stringify(props, null, 2));
console.log(`bench fixture ready: ${PHOTOS} photos, ${chunks.length} chunks, 50s`);
