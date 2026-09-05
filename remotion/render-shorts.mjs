import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// YouTube: 1分を超える Short に有効な著作権申立てが付くと **全世界でブロック**される
// (種類を問わず・manual claim を含む)。1分以下の Short にこの制限は無い。
// 出典: https://support.google.com/youtube/answer/15424877 (2026-09-01 取得)
// タイムライン尺ではなく「書き出したファイルの実尺」で見ること。
const MAX_SEC = Number(process.env.MAX_SHORT_SEC ?? "57");

const props = JSON.parse(readFileSync(new URL("./props-short.json", import.meta.url), "utf-8"));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/**
 * BGM は書き出し後に ffmpeg で混ぜる。
 *  - -stream_loop -1 -ss <offset> : 曲の途中から流して足りなければループ (build-news-video.ts と同じ)
 *  - sidechaincompress            : ナレーションが鳴っている間だけ BGM を自動で下げる。
 *    アイキャッチや文の切れ目では戻るので、平坦なベタ敷きより台詞が抜ける。
 * 最後に loudnorm で YouTube 基準 (-14 LUFS) へ。
 */
props.videos.forEach((v, i) => {
  const id = `Short-${i + 1}-${v.code}`;
  const raw = `out/_${id}.mp4`;
  const final = `out/short-${v.index}-${v.code}.mp4`;
  console.log(`\n=== ${id} → ${final}`);
  run("npx", ["remotion", "render", id, raw, "--log=error"]);

  if (v.bgm) {
    const fadeOut = Math.max(0.1, v.duration - 1.4);
    const chain =
      `[1:a]volume=${v.bgm.volume},` +
      `afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOut.toFixed(2)}:d=1.4[bg];` +
      `[0:a]asplit=2[voice][key];` +
      // パラメータは build-news-video.ts の DUCK と同一にする (自前で強めたら BGM が -33dB まで潰れた)
      `[bg][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[duck];` +
      `[voice][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
      `loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
    run("ffmpeg", ["-y", "-v", "error", "-i", raw,
      "-stream_loop", "-1", "-ss", String(v.bgm.offset), "-i", v.bgm.file,
      "-filter_complex", chain, "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", final]);
  } else {
    run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", final]);
  }
  run("rm", ["-f", raw]);

  const probed = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                                       "-of", "csv=p=0", final], { encoding: "utf-8" });
  const dur = parseFloat((probed.stdout || "").trim());
  if (!Number.isFinite(dur)) {
    console.error(`  !! ${final}: 尺を取得できなかった`);
    process.exit(1);
  }
  if (dur > MAX_SEC) {
    console.error(`  !! ${final}: ${dur.toFixed(1)}s > ${MAX_SEC}s — 1分超の Short は著作権申立てで全世界ブロックされる`);
    process.exit(1);
  }
  console.log(`  ${final}: ${dur.toFixed(1)}s (上限 ${MAX_SEC}s)`);
});
console.log("\nall shorts rendered");
