# Daily World 60 — Prompt Stack

各アセットの制作プロンプト集。 2026 年版リサーチ ([research-brief-2026.md](./research-brief-2026.md)) を直接反映。

---

## 1. 60秒動画 (`final.mp4`)

**目的:** Daily World 60 の本体。YouTube Shorts / Instagram Reels / TikTok 共通 1080x1920。

**構成 (Joyspace 2026 / Specificit 2026):**

| 時間 | シーン | 内容 |
|---|---|---|
| 0–3s   | Intro     | `[mmdd]·WORLD` 黄ストライプ + DAILY WORLD 60 + 3 国旗 |
| 3–19s  | Story 1   | 国旗 60% scale + ISO code + 出典 + 大見出し (赤系背景) |
| 19–35s | Story 2   | 同上 (紺背景) |
| 35–51s | Story 3   | 同上 (黒背景) |
| 51–60s | Today's Word + CTA | 紺 + 黄カード "停戦合意" + "明日も60秒。フォローを。" |

**実装プロンプト (Claude / AI Coder への指示):**

```
60秒の縦動画 (1080x1920, 30fps) を ffmpeg + SVG で作る。

入力: voice.mp3 (60秒前後の英語ナレ), script-en.json (3 stories + todaysWord)
出力: final.mp4

構成: 上記 5 シーン (3s + 16s × 3 + 9s)。
背景: 各シーン単色 (グラデ禁止)。
  - intro #0A0A0A, story1 #E63946, story2 #0F1B3D, story3 #0A0A0A, outro #0F1B3D
SVG → PNG → ffmpeg zoompan で軽い ken-burns 動き (1.0→1.06)。
全シーン連結 → voice.mp3 重ね → libx264 CRF 20, AAC 192k。

字幕: 余裕あれば libass 環境で ASS burn (Hiragino Sans W9, FontSize 14, 
  PrimaryColour=&H00FFFFFF&, Outline 8px black, MarginV 620)。
無理な環境では SVG シーンに headline を大きく焼き込んで字幕代替。

Anti-AI-slop チェック:
  - Helvetica / Arial 禁止 → Hiragino Sans W9 のみ
  - グラデ禁止 → 単色塗り
  - 中央寄せの完全対称禁止 → 1/3 line 寄せ
  - 全シーンに asymmetric 要素 1 個 (黄ストライプ / 黄下線 など)
```

**仕様の根拠:** ThumbMagic 2026 / Vocallab 2026 / Blitzcut 2026 / Charlie Guo Field Guide 2026。

---

## 2. YouTube Shorts サムネ (`yt-thumbnail-v.png` + `yt-thumbnail-h.png`)

**目的:** Shorts player (1080x1920) と Search/Browse (1280x720) の両方に出る。中央 16:9 が両方で読める設計。

**実装プロンプト:**

```
2 枚作る。

A. yt-thumbnail-h.png (1280x720) — Search/Browse 表示
   - 背景 #0A0A0A
   - 左 60%: 赤 #E63946 帯 (top 160px) "今日、世界で。"
     + "3本." 200pt #FFFFFF + "60秒." 200pt #F5E63B (off-center, 1/3 line)
   - 右 40%: 国旗 3 枚を縦に積む (180pt each)
   - 下部 dateline: "5/30 · DAILY WORLD 60"

B. yt-thumbnail-v.png (1080x1920) — Shorts player
   - 同じ要素を縦長に再配置
   - 中央 1080x607 (16:9 等価) 領域に主要素を寄せる
   - 「60」を 540pt の hero number として置く (赤)

全フォント: Hiragino Sans W9 のみ。
0-3 word hook (ThumbMagic 2026 — eye-tracking)。
顔写真は使わない (faceless 200K subs 以下は face は CTR ブースターにならない)。
代わりに「国旗 + 巨大数字」をフォーカルポイントに。
```

**仕様の根拠:** Alici.AI 2026, AutoFaceless 2026, BananaThumbnail 2026, ThumbMagic 2026.

---

## 3. Instagram Reels Cover (`ig-reels-cover.png`) + Feed (`ig-feed.png`)

**目的:** Reels グリッド上の小サイズ表示 (~360x640) で読めて、フィード上で日刊新聞っぽく見える。

**実装プロンプト:**

```
A. ig-reels-cover.png (1080x1920) — Reels cover
   - 背景 #0F1B3D (Bloomberg-coded navy)
   - Safe zone: top 210px (UI bar) と bottom 320px (caption+actions) は空ける
   - Hook ブロック Y 220-720:
     - 黄ストライプ + "5/30 · WORLD"
     - "3カ国、" #FFFFFF 130pt
     - "60秒で。" #F5E63B 130pt
   - Mid Y 880-1450: 3 国チップ (黄 box ISO code + 国旗 + source + headline)
   - Footer (Y 1560): @60dailyworld

B. ig-feed.png (1080x1080) — Feed post
   - 背景 #F4F1EA (newspaper off-white) — グラデも navy もなし
   - Top stripe (黒 6px+2px ダブルライン、新聞風)
   - "今日の3本" 130pt 黒 / "世界ニュース" 130pt #E63946
   - 3 stories リスト: 国旗 + headline + source・ISO code
   - Bottom: @60dailyworld + プラットフォーム名

全フォント: Hiragino Sans W9 / W6。
パステルグラデ・purple-pink IG default 禁止 (aigoodies 2026 — AI slop tell)。
```

**仕様の根拠:** Metricool 2026, TryMyPost 2026, Kreatli 2026, Predis.ai 2026.

---

## 4. TikTok Cover (`tiktok-cover.png`)

**目的:** FYP/Profile グリッド上でも視認、bottom 200px は UI 用に clean を保つ。

**実装プロンプト:**

```
tiktok-cover.png (1080x1920)
   - 背景 #0A0A0A
   - Y 280: "STOP SCROLLING" 60pt #F5E63B (letter-spacing 8)
     ← Pattern interrupt + direct address (Sprout Social 2026 hook formula)
   - Y 460-620: "世界で今" / "起きてる3本" 170pt #FFFFFF
   - Mid: 3 国チップ (黒地 + 黄枠) 国旗 + ISO + source + headline
   - Footer Y 1680: @60dailyworld
   - Bottom 200px は空白 (TikTok UI 用)

全フォント: Hiragino Sans W9。
Pattern interrupt (黄色アクセントの英語コマンド) → ストップスクロール後に日本語へ転調。
```

**仕様の根拠:** Sprout Social 2026, Vugola 2026, Blitzcut 2026, Opus.pro 2026.

---

## 5. X (Twitter) スレッド (`x-thread.txt`)

**目的:** 文字のみ。画像なし。X 日本語アカウント @60dailyworld 用。

**実装プロンプト:**

```
5 ツイート構成、各 140 字以内、日本語のみ。
画像なし、リンクなし (本文に dailyworld60 LP 等あれば 5 ツイ目に置く)。

Tweet 1: Hook
  🌍 [mmdd]の世界ニュース、3本。
  60秒の英語動画と一緒に流します。
  #DailyWorld60 #世界ニュース

Tweet 2-4: 各ストーリー
  [国旗] [見出し]
  (空行)
  [60-80字の要約]
  (空行)
  出典: [SourceName]

Tweet 5: 締め
  今日の英単語: "[word]" = [日本語訳]
  (空行)
  英語版60秒動画は YouTube / TikTok / Instagram @60dailyworld で配信中。
  毎朝、世界の3本だけ。

AI 臭除去 (~/.company/marketing/ai-smell-removal-guide.md 準拠):
  - 禁止: いかがでしたか / ぜひ / ご紹介 / することができます / と考えられます
        / 結論として / まとめると / 3つのポイント
  - 禁止記号: em-dash (—)
  - 文末を3連続同一にしない (です・ます・だ を混ぜる)
  - 数字・固有名詞・地名を必ず入れる
```

**自動チェック:** `scripts/generate-x-thread.ts` が AI-smell 9 フレーズ + em-dash を実行時 lint。

---

## 6. ナレーション (`voice.mp3`)

**実装プロンプト:**

```
edge-tts en-US-AvaNeural --rate +5% --pitch +0Hz
入力テキスト: script-en.json の hook + 3 stories + todaysWord + close
   (Script.toNarration が組み立てる)

長さ目標: 60秒 (estimatedSeconds: 58)。

CEFR B1: 一文 ≤20 words、active voice、common vocabulary 中心。
ストーリーは "Story N from [flag] [code]." で区切る → 動画シーン境界と同期。

副産物: voice.vtt (sentence-level WebVTT subtitles, SubMaker 出力)。
   libass 環境では ASS スタイル付き burn-in に再利用。
```

---

## 制作チェックリスト

毎日のアセット生成後に確認:

- [ ] 動画 60s ±2s
- [ ] 字幕 (or 画面焼き headline) が見出しと完全一致 (誤訳・脱字なし)
- [ ] 各国の国旗が正しい (CD=コンゴ、KW=クウェート等 ISO 2字準拠)
- [ ] 出典は信頼ソース (NPR/BBC/Reuters/AP/PBS/Bloomberg)、TASS/Xinhua/Press TV 不可
- [ ] X スレッドに AI-smell フレーズ 0 件 (lint 通過)
- [ ] 画像にグラデーション・Helvetica・purple-pink パレットが無い
- [ ] 全画像 footer に @60dailyworld 表示

---

## 参照

- リサーチ: [research-brief-2026.md](./research-brief-2026.md)
- AI 臭除去ガイド: `~/.company/marketing/ai-smell-removal-guide.md`
- Hero ブログ SEO: `~/Hero-Cram-School/.company/marketing/seo-knowledge-base-2026.md`
- Skills インベントリ: `~/.company/marketing/skills-inventory.md`
