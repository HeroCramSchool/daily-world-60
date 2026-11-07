import { test } from "node:test";
import assert from "node:assert/strict";
import { bgmMixArgs } from "./map-bgm.js";

const bgm = { file: "/x/Rising Tide.mp3", offset: 42, conflict: false, volume: 0.25 };

test("声があるときは本編と同じく、声が鳴る間だけ BGM を下げてから -14 LUFS にそろえる", () => {
  const args = bgmMixArgs("raw.mp4", "out.mp4", bgm, 12.4, true);
  const chain = args[args.indexOf("-filter_complex") + 1];
  assert.match(chain, /\[1:a\]volume=0\.25,afade=t=in:st=0:d=1\.2,afade=t=out:st=11\.00:d=1\.4\[bg\]/);
  assert.match(chain, /\[0:a\]volume=-13dB,asplit=2\[voice\]\[key\]/);
  assert.match(chain, /\[bg\]\[key\]sidechaincompress=threshold=0\.02:ratio=8:attack=20:release=300\[duck\]/);
  assert.match(chain, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14:TP=-1\.5:LRA=11\[a\]$/);
  assert.deepEqual(args.slice(args.indexOf("-stream_loop"), args.indexOf("-stream_loop") + 6), ["-stream_loop", "-1", "-ss", "42", "-i", "/x/Rising Tide.mp3"]);
  assert.deepEqual(args.slice(-3), ["-t", "12.400", "out.mp4"]);
});

test("無音の地図 (読み上げ失敗) は BGM だけを入れる", () => {
  const args = bgmMixArgs("raw.mp4", "out.mp4", bgm, 7, false);
  const chain = args[args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(chain, /\[0:a\]|sidechaincompress|amix/);
  assert.match(chain, /afade=t=out:st=5\.60:d=1\.4,loudnorm=I=-14:TP=-1\.5:LRA=11,alimiter=limit=0\.7:level=disabled\[a\]$/);
});
