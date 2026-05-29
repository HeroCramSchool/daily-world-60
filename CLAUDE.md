# Daily World 60 — Shorts Pipeline

## 役割
世界中のニュースを毎朝60秒動画にして英語(YT/IG/TikTok) + 日本語(X) で自動配信する DDD パイプライン。

## アーキテクチャ
**DDD 4層**:
- `domain/` — ビジネスロジック中心、外部依存ゼロ。ここでテスト容易
- `application/` — ユースケース + ポート（外部IF抽象）
- `infrastructure/` — 外部実装（RSS / Claude API / edge-tts / ffmpeg / 各SNS）
- `interfaces/cli/` — 実行エントリ

依存方向: `interfaces → application → domain ← infrastructure`

## 編集ルール
- **domain には外部依存を入れない**（純粋なビジネスロジック）
- **infrastructure の実装は application/ports/ の interface を必ず implements する**
- 新しい外部サービス追加時は port → infrastructure 実装 → usecase の順
- ニュースソース追加は `config/rss-feeds.json` のみ編集（コード変更不要）

## コンテンツ方針
- 60秒、Top 3 + Today's word + CTA
- 英語: CEFR B1（ESL平易化）
- 日本語: AI臭除去ルール準拠（`~/.company/marketing/ai-smell-removal-guide.md`）
- 出典URL必ず明示
- 国営プロパガンダ系（TASS / Xinhua / Press TV）は除外

## コスト原則
- 月額 ¥0 を維持
- 新規ツール追加時は無料代替を検討
- 既存資産（edge-tts, ffmpeg, Whisper, Playwright, Efecto Skill）を最大限活用

## 関連
- 全Skill インベントリ: `~/.company/marketing/skills-inventory.md`
- AI臭除去: `~/.company/marketing/ai-smell-removal-guide.md`
- 親部署: `~/.company/affiliate/CLAUDE.md`
