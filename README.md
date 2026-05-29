# Daily World 60 — Shorts Pipeline

世界中のニュースを毎朝6:00 NZST に60秒動画にして自動配信する DDD パイプライン。

## 媒体

- **英語版** (YouTube Shorts / Instagram Reels / TikTok) — `Daily World 60`
- **日本語版** (X / Twitter) — `Daily World 60 日本版`

## 完全無料スタック

- Claude API（既存サブスク経由）
- edge-tts（Microsoft Edge TTS、無料・無制限）
- ffmpeg（既存）+ Pexels API（無料 B-roll）
- YouTube Data API v3（無料・公式）
- Playwright（既存）で IG / TikTok 下書き保存

## DDD アーキテクチャ

```
shorts-pipeline/
├── domain/              ← ビジネスロジック中心、外部依存なし
│   ├── news/            ← ニュース取得・選定
│   ├── script/          ← スクリプト生成
│   ├── media/           ← 音声・動画・サムネ
│   ├── publishing/      ← 配信
│   └── shared/          ← 共通カーネル（Language / Country / Result 等）
├── application/         ← ユースケース・ポート（外部IF抽象）
│   ├── usecases/
│   └── ports/
├── infrastructure/      ← 外部実装（RSS / Claude API / edge-tts / ffmpeg / Pexels / 各SNS）
│   ├── rss/
│   ├── claude/
│   ├── tts/
│   ├── ffmpeg/
│   ├── pexels/
│   ├── thumbnail/
│   ├── youtube/
│   ├── instagram/
│   ├── tiktok/
│   └── x/
├── interfaces/cli/      ← 実行エントリーポイント
├── config/              ← rss-feeds.json 等
├── output/              ← YYYY-MM-DD/ で日次生成物
└── cron/                ← 定期実行スクリプト
```

依存方向: `interfaces → application → domain ← infrastructure`
（domain は他に依存しない。infrastructure は application の port を実装する）

## クイックスタート

```bash
cd /Users/hiro/.company/affiliate/automation/shorts-pipeline
cp .env.example .env
npm install
pip install --user edge-tts  # 一度だけ

# 段階別実行（デバッグ用）
npm run fetch       # ニュース収集のみ
npm run curate      # Top 3 選定 + 英語+日本語スクリプト生成
npm run tts         # 音声生成
npm run broll       # B-roll fetch
npm run render      # 動画レンダー
npm run thumbnail   # サムネ生成
npm run publish     # 全プラットフォーム配信

# 全部一気に
npm run pipeline    # fetch → curate → tts → render → thumbnail → publish

# テスト（投稿せず生成物だけ確認）
npm run pipeline -- --dry-run --skip-audio
```

## CLAUDE_MODE — API キー不要モード

デフォルトは **CLI モード**（`CLAUDE_MODE=cli`）。
`claude -p` 経由で動作し、Anthropic API キー不要。Pro サブスクで動く。

| モード | 必要なもの | 使う場面 |
|---|---|---|
| `cli`（既定） | `claude` CLI が PATH | 日常運用、Routine、ローカル cron |
| `api` | `ANTHROPIC_API_KEY` | 高並列が必要なテスト、CI |

## Skill フル活用

Curate / Translate / Publishing の各段階で **Skill 群を協働させる**:

| 段階 | 活用 Skill |
|---|---|
| Top 3 選定・スクリプト生成 | `content-strategy`, `tiktok-research`, `instagram-research`, `social`, `social-media-manager` |
| 英語スクリプト最適化 | `tiktok-captions`, `social` |
| 日本語化 (X) | `twitter-thread-creation`, `twitter-automation`, `content-strategy` |
| サムネ | `youtube-thumbnail`, `efecto-social-media` |
| YouTube 投稿 | `youtube` |
| IG 投稿 | `instagram`, `instagram-automation`, `instagram-content-generation` |
| TikTok 投稿 | `tiktok-captions`, `tiktok-research`（最終 hook 調整） + Playwright（下書き）|
| X 投稿 | `twitter-automation`, `twitter-thread-creation` |

これらはコードから直接 import するのではなく、**`claude -p` の prompt 内で「Use X skill to ...」と指示** することで自動起動される。
domain/application は Skill の存在を知らない（DDD の依存ルール維持）。

## Routine セットアップ（PC 不要・推奨運用）

`cron/routine-prompt.md` を `schedule` Skill 経由で Anthropic Routine に登録すれば、PC が起動していなくてもクラウド側で実行される。

```
# Claude Code セッション内で:
schedule Skill を起動して、
~/.company/affiliate/automation/shorts-pipeline/cron/routine-prompt.md
を毎朝6:00 NZST（cron: 0 18 * * *）で実行する routine を作って
```

## ローカル cron（フォールバック）

PC 常時起動できる場合は cron でも動く:

```bash
# crontab -e で追加
0 18 * * * /Users/hiro/.company/affiliate/automation/shorts-pipeline/cron/daily-6am.sh
```

## cron 設定

```bash
# 毎朝6:00 NZST (UTC 18:00)
0 18 * * * /Users/hiro/.company/affiliate/automation/shorts-pipeline/cron/daily-6am.sh
```

## コンテンツ方針

- **形式**: 60秒、Top 3 + Today's word + Close CTA
- **英語レベル**: CEFR B1（ESL視聴者）
- **ソース**: 全世界25社、米英偏重しない
- **除外**: 国営プロパガンダ系（TASS / Xinhua / Press TV）
- **信頼性**: 各ニュースに出典URL明示

## 関連

- 全Skill インベントリ: `~/.company/marketing/skills-inventory.md`
- AI臭除去ガイド: `~/.company/marketing/ai-smell-removal-guide.md`（日本語版Xに適用）
- 配置親: `~/.company/affiliate/`
