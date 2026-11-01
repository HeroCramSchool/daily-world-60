import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapSceneParts, type MapLane } from "../../scripts/lib/mapscene.js";
import type { ExplainerVideo, XBeat, XVisual } from "../src/lib/explainerTypes.js";

// ExplainerPreview の見本。文はすべて架空 (SAMPLE) で公開しない。
// public/fixtures/ (gitignore) に無音の音声と地図 PNG を書き、点の座標を PNG とそろえるため
// fixtures/explainer-sample.json も書き直す。mapSceneParts は決定的なので何度回しても同じ JSON になる。
// 実行: npx tsx remotion/fixtures/make-explainer-fixture.ts

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, "..", "public", "fixtures");
const FPS = 30;
const ACCENT = "#F5E63B";
const TAIL_SEC = 0.9;

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

const r2 = (n: number) => Math.round(n * 100) / 100;

async function mapPng(lane: MapLane, name: string) {
  const parts = mapSceneParts(lane, ACCENT);
  const svg = path.join(PUB, `_${name}.svg`);
  await fs.writeFile(svg, parts.baseSvg, "utf-8");
  await run("rsvg-convert", ["-w", "1080", "-h", "1920", svg, "-o", path.join(PUB, `${name}.png`)]);
  await fs.unlink(svg);
  return { bg: `fixtures/${name}.png`, xy: parts.markers.map(m => ({ x: r2(m.x), y: r2(m.y) })) };
}

async function main() {
  await fs.mkdir(PUB, { recursive: true });

  const port = { lon: -21.9, lat: 64.15 };
  const townB = { lon: -18.1, lat: 65.68 };
  const harbor = { lon: -14.0, lat: 65.26 };
  const zoom = await mapPng({
    focus: [-18.5, 64.9],
    markers: [
      { ...port, label: "Sample Port", kind: "city" },
      { ...townB, label: "Town B", kind: "city" },
      { ...harbor, label: "Sample North Harbor", kind: "city" },
    ],
  }, "map-zoom");
  const route = await mapPng({
    focus: [-18.0, 64.7],
    markers: [{ ...port, kind: "city" }, { ...harbor, kind: "city" }],
  }, "map-route");

  const lines: Array<{ say: string; sourceName: string; visual: XVisual }> = [
    {
      say: "SAMPLE: 1,250 test drones hit Town B and Sample North Harbor overnight.",
      sourceName: "SAMPLE WIRE",
      visual: {
        kind: "map_zoom", bg: zoom.bg,
        points: [
          { ...zoom.xy[0], label: "Sample Port" },
          { ...zoom.xy[1], label: "Town B" },
          { ...zoom.xy[2], label: "Sample North Harbor" },
        ],
      },
    },
    {
      say: "This sample report says 1,250 drones were launched in one night.",
      sourceName: "SAMPLE WIRE",
      visual: { kind: "counter", value: 1250, label: "Test drones launched (sample)" },
    },
    {
      say: "Side A says it stopped 980. Side B says only 410.",
      sourceName: "SAMPLE TIMES",
      visual: {
        kind: "bars",
        items: [
          { label: "Side A says it stopped", value: 980 },
          { label: "Side B says it stopped", value: 410 },
          { label: "Sample observers estimate", value: 655 },
        ],
      },
    },
    {
      say: "The sample route ran from Sample Port to Town C, far inland.",
      sourceName: "SAMPLE TIMES",
      visual: { kind: "route", bg: route.bg, from: { ...route.xy[0], label: "Sample Port" }, to: { ...route.xy[1], label: "Town C" } },
    },
    {
      say: "A sample official called it placeholder text for a layout test.",
      sourceName: "SAMPLE DAILY",
      visual: { kind: "quote_card", who: "Sample Official", text: "This is placeholder text for a layout test, not real news." },
    },
    {
      say: "So far this sample month: 12,500 drones. None of this is real.",
      sourceName: "SAMPLE DAILY",
      visual: { kind: "counter", value: 12500, label: "Sample month total" },
    },
  ];

  // 読み上げの代わりに語の長さから時刻を作る (Kokoro の語タイムスタンプと同じ形)
  let t = 0.12;
  const beats: XBeat[] = lines.map((l, i) => {
    const words = l.say.split(/\s+/).filter(Boolean).map(w => {
      const d = r2(0.17 + 0.04 * w.replace(/[^\p{L}\p{N}]/gu, "").length);
      const word = { w, t: r2(t), d };
      t += d + 0.06;
      return word;
    });
    const last = words[words.length - 1];
    const end = r2(last.t + last.d);
    t = end + 0.42;
    return { id: `l${i + 1}`, start: words[0].t, end, words, visual: l.visual, sourceName: l.sourceName };
  });
  const audioSec = r2(beats[beats.length - 1].end + 0.25);
  const duration = r2(audioSec + TAIL_SEC);

  const mp3 = path.join(PUB, "explainer-sample.mp3");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(audioSec),
                       "-c:a", "libmp3lame", "-b:a", "64k", mp3]);

  const video: ExplainerVideo = {
    style: "explainer",
    code: "zz",
    index: 1,
    accent: ACCENT,
    country: { name: "SAMPLELAND", flag: null },
    hook: "1,250 sample drones in one night",
    audio: "fixtures/explainer-sample.mp3",
    bgm: null,
    duration,
    beats,
    source: { name: "SAMPLE WIRE", url: "https://example.com/sample" },
    date: "2026-11-01",
  };
  await fs.writeFile(path.join(HERE, "explainer-sample.json"), JSON.stringify({ fps: FPS, video }, null, 2) + "\n");
  console.log(`[fixture] ${beats.length} beats, audio ${audioSec}s, video ${duration}s → fixtures/explainer-sample.json`);
  for (const b of beats) console.log(`  ${b.id} ${b.start}-${b.end} ${b.visual.kind}`);
}

main().catch(e => { console.error(e); process.exit(1); });
