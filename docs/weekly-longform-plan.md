# Weekly Long-form Deep Dive — 実装プラン (2026-06-09 確定)

日次の 9 本ショート(縦)とは別に、**週1の長尺(横)深掘り動画**を作る。収益化の 4,000 時間視聴ルートに直結。

## 確定仕様 (Hiro 承認 2026-06-09)
- **フォーマット**: 1テーマ深掘り（その週の最重要ニュース1件を多角的に解説）
- **向き/尺**: **横 16:9 (1920×1080)・8〜12分**
- **公開先**: YouTube 長尺（Shorts ではない）@60dailyworld
- **言語**: 英語ナレーション(CEFR B1ベース、ただし深掘りなので語彙は少し上げてよい) + 日本語は概要/サムネ
- **BGM**: 既存 `assets/news-bed.mp3`(Investigations, CC-BY) を流用。CC-BY 帰属は概要欄へ
- **重複**: 日次の posted-ledger とは別管理可。深掘りテーマは日次と被ってよい（角度が違うため）

## 段階ビルド（次セッションで着手）
### Phase 1 — 週次 deep-dive Routine（content engine）
- 新しい scheduled routine（週1, 例: 日曜 18:00 UTC）。
- その週の posted-ledger / 主要ニュースから **1テーマ**選定 → 深掘り Web リサーチ → 長尺台本を生成。
- 台本構造(セクション): hook → background(背景) → what happened(経緯) → key angles(論点/各立場) → why it matters → what's next → recap。各セクションに sources。
- 出力: Drive に `longform-YYYY-WW.json`（または `-YYYY-MM-DD.json`）。schema は別途定義（sections[] + sources[] + title + thumb案）。
- 台本は ~1,200-1,800語(8-12分 @ ~150wpm)。

### Phase 2 — 横レンダラ（最重量）
- 新 `build-longform-video.ts`（1920×1080）。新 SVG レイアウト: タイトルカード / セクション見出し / lower-third / 引用・出典 / chapter区切り。
- TTS は長尺(edge-tts, 既存流用)。VTT 同期。
- 背景: 既存 `fetch-broll`(Wikimedia) をテーマ画像多めに拡張、章ごとに切替。
- BGM: 既存 mux ロジック流用（横でも同じ）。
- チャプター(YouTube description の타임スタンプ)。

### Phase 3 — 長尺 publish + cron
- `publishYoutube` を長尺用に（categoryId, タグ, 横サムネ `yt-thumbnail-h`）。Shorts 化されないよう尺>60s。
- 週次 cron を publish.yml に追加 or 別 workflow `publish-longform.yml`。
- 概要欄に章タイムスタンプ + 出典 + CC-BY 音楽帰属。

## 留意
- 既存の日次パイプライン(縦ショート)とは**別経路**にして干渉させない（別スクリプト・別 workflow 推奨）。
- 初回は Phase 1 の台本サンプルを Hiro に見せて内容方向を確認 → その後 Phase 2/3。
