# Remotion レンダラー

`output/<date>/longform.json` から 1920x1080 の解説動画を作る。
日次ショート (`scripts/build-news-video.ts`) とは別経路で、干渉しない。

```bash
npx tsx remotion/prep.ts 2026-06-16        # ナレーション生成 + props.json
cd remotion && npm run build                # レンダー + 音量正規化 → out/longform-remotion.mp4
npm run studio                              # ブラウザで確認・微調整
```

## prep.ts が決めていること

Remotion 側は props を描くだけで、判断は全部ここで終わらせる。

- **ナレーション**: edge-tts の WordBoundary で単語タイムスタンプごと取得
- **字幕行**: 原文の文境界に整列 (`sentenceBounds`) してから均等割り。文をまたぐ改行と孤立行が出ない
- **データコールアウト**: 読み上げ順に「数値 + 単位」を検出し、その語が発話された時刻に出す。
  `from A to B` は比較カードにまとめる。ラベルはナレーション原文の語をそのまま使う（言い換えない）
- **背景写真**: `_lfbg-img-sNN.jpg` があれば流用する

## 描画の方針

- **写真をズーム・パンさせない**（右の固定カードに収める）。動きは見出し・数値カード・字幕だけが担当する
- **数字をカウントアップさせない**。途中フレームに実在しない値が映ると、切り取られたとき誤情報になる
- 出典チップを本編中は常時出す
- 書き出し後に loudnorm で -14 LUFS に揃える (素のままだと平均 -24dB で小さい)

## 既知の制約

- `prep.ts` は edge-tts (`scripts/tts-words.py`) を使う。ショート側の Kokoro とは別
- CI で回す場合、Remotion は headless Chrome を自前で落とすので初回が重い

---

# 日次ショート (9:16)

`output/<date>/script-en.json` + `voice-{code}.vtt` から 1080x1920 を3本作る。
本番の `scripts/build-news-video.ts` とは別経路。**本番には接続していない。**

```bash
npx tsx remotion/prep-short.ts 2026-06-16   # ナレーション再生成 + props-short.json
cd remotion && npm run render:short          # out/short-{index}-{code}.mp4
```

## prep-short.ts が決めていること

- **ナレーション**: 既存 vtt の文を連結して作り直す（原稿は公開済みと同一）。
  既定は **Kokoro-82M** (`am_michael`・Apache-2.0・自前実行)、失敗時は edge-tts へ降格。
  単語タイムスタンプが取れるので、字幕の表示語と発話語が 1:1 で一致する
  （build-news-video.ts の `resampleDurs` による近似が不要）
- **カット割り**: 文ごとに絵1枚、文の中は 3-6 語のチャンク。`MAX_SCENE_SEC` / `MAX_WORDS_PER_CHUNK` /
  `MIN_CHUNK_SEC` は本番と同じ既定値
- **チャンク境界**: 均等割りを基準に ±2 語ずらし、冠詞・前置詞の直後と大文字語の連なりで切らない
  （`at Bath | Iron Works` や `dollars the` のような分断を避ける）

## アイキャッチ

`src/short/EyeCatch.tsx` — フック直後に 0.8 秒のブランドスティング。
効果音は `public/sfx/eyecatch.mp3`（ffmpeg で合成）。

冒頭には置かない（ショートは最初の 1 秒で離脱が決まるため、フックを遅らせない）。

尺を差し込むためにナレーションを `hookEnd` で 2 本に割り、後半を `trimBefore` でずらしている。
字幕は音声時間で同期しているので、ずらした分を `audioOffset` として引いて合わせる。
`startFrom` / `endAt` は 4.0.484 では非推奨（`trimBefore` / `trimAfter` が現行名）。

## BGM

`render-shorts.mjs` が書き出し後に ffmpeg で混ぜる。

- 曲と開始位置は `prep-short.ts` の `pickBgm` が決める。`build-news-video.ts` と同じ規則
  （`assets/bgm/*` があればローテ、無ければ `assets/news-bed.mp3`。開始位置は日付でベースを回し
  story index で等間隔にずらす → 同日の3本が必ず別区間）
- ダッキングは `sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300`、音量 0.25。
  **本番と同じ値にすること**。強めた版（ratio 12 + makeup、音量 0.20）は実測で BGM が
  -33dB まで潰れ、ナレーションが連続するため常時押さえ込まれた（2026-09-01 実測）
- 本番に無い追加として冒頭 1.2s のフェードイン / 末尾 1.4s のフェードアウト

**曲は `news-bed.mp3` 1曲のみ。** `assets/bgm/` に複数置けば曲もローテする（コード変更不要）。
ポリシー上の理由は `assets/bgm/README.md` を参照。

## 未移植

- 本文の SFX（アイキャッチの効果音のみ実装済み）
- 地図シーン（`laneFromStory`）。6月データにマーカーが無く未検証
