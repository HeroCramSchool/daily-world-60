# 紛争回の BGM プール — 帰属表示（必須）

すべて **Kevin MacLeod (incompetech.com)** / **CC BY 4.0**。

`scripts/lib/bgm-select.ts` の `isConflictStory()` が true の回だけ、このフォルダから
動画ごとにローテーションする。通常回は `assets/bgm/` を使う。

## なぜ単曲でなくプールなのか

戦争回を1曲に固定すると、世界ニュースでは「3本とも同じBGM」の日が普通に起きる
（2026-09-05 の実測: Iran / US / Ukraine の3本すべてが紛争判定）。
これは BGM をローテーションする目的（`assets/bgm/README.md` 参照）を紛争回だけ
素通りさせることになるため、プールにした。

## 選定基準

戦争・被害を扱う回に敷く曲なので、次を外している。

- ホラー／不安を煽るもの（実在の被害者に対して不謹慎）
- アクション・エピック系（戦争の英雄化になる）
- 宗教曲（紛争の当事者性に触れる）
- 過度に感傷的なもの（"Extraordinarily depressing" と自称する曲など）

残したのは、抑制的で重く、ナレーションの下に敷ける曲。テンポ 48〜76 BPM。

## 各トラックの帰属文（そのまま概要欄へ）

投稿側は `bgm-used.json` を読んで自動で出す（`scripts/lib/bgm-credit.ts`）。
以下は手動で使う場合の控え。

### Grim League.mp3
- 00:02:39 / 76 BPM / ドラムアンサンブルのみ
- 採用理由: "This all drum ensemble will convey the gravity of the situation"
  旋律が無いのでナレーションと競合しない。

```
Grim League Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### Dark Times.mp3
- 00:03:04 / 48 BPM
- 採用理由: "Deeply troubling and somber, heavy on the bass strings"

```
Dark Times Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### Plaint.mp3
- 00:03:16 / 65 BPM / バスーン + ハープ
- 採用理由: "Works very well behind dialog"

```
Plaint Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

### Lost Time.mp3
- 00:03:47 / 55 BPM
- 採用理由: "Is someone dying onscreen, but you still need some dialog" — 台詞の下で
  重い場面を支えるために書かれた曲。

```
Lost Time Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```

## 取得元

https://incompetech.com/music/royalty-free/mp3-royaltyfree/<曲名>.mp3
リポジトリ用に 96kbps へ再エンコード済み（既存ベッドと同じ規格）。
