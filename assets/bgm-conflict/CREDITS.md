# 紛争回の BGM プール — 帰属表示（必須）

すべて **Kevin MacLeod (incompetech.com)** / **CC BY 4.0**。

`scripts/lib/bgm-select.ts` の `isConflictStory()` が true の回だけ、このフォルダから
動画ごとにローテーションする。通常回は `assets/bgm/` を使う。

## なぜ単曲でなくプールなのか

戦争回を1曲に固定すると、世界ニュースでは「3本とも同じBGM」の日が普通に起きる
（2026-09-05 の実測: Iran / US / Ukraine の3本すべてが紛争判定）。
BGM をローテーションする目的（`assets/bgm/README.md`）を紛争回だけ素通りさせるため、
プールにした。

## 選定基準（2026-09-07 改定）

**テンポのある緊張系**。当初は葬送的な曲（Grim League / Dark Times / Plaint /
Lost Time・48〜76 BPM）を入れたが、実聴で「重すぎる／葬送的」と判断されたため
全交換した。

現在は 94〜110 BPM の Dark + Driving 系で揃えている。緊迫感は保ちつつ、
30〜55 秒のショートのテンポと、2 秒ごとに切り替わる写真に合う速さ。

除外は変えていない — アクション／エピック系（戦争の英雄化）、ホラー系
（実在の被害者に対して不謹慎）、宗教曲。

## 各トラック

投稿側は `bgm-used.json` を読んで帰属を自動で出す（`scripts/lib/bgm-credit.ts`）。
以下は手動で使う場合の控え。

### Consequence.mp3
- 00:05:02 / 101 BPM / Electronica / Dark, Driving, Mysterious
- 「淡々と進むドライブ系」。通常プールから移した。

```
Consequence Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### Invariance.mp3
- 00:03:37 / 108 BPM / Soundtrack / Dark, Driving, Mysterious, Suspenseful

```
Invariance Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### Industrial Cinematic.mp3
- 00:04:04 / 110 BPM / Soundtrack / Driving, Suspenseful

```
Industrial Cinematic Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### I Can Feel it Coming.mp3
- 00:03:35 / 94 BPM / Soundtrack / Driving, Suspenseful, Mysterious
- カタログ説明は "run-of-the-mill tension filler music" — 前に出ない緊張の下敷き。

```
I Can Feel it Coming Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

## 取得元

https://incompetech.com/music/royalty-free/mp3-royaltyfree/<曲名>.mp3
リポジトリ用に 96kbps へ再エンコード済み（既存ベッドと同じ規格）。
