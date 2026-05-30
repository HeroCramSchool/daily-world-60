# Secrets セットアップガイド — Daily World 60

GitHub Actions が4プラットフォームに自動投稿するために必要な認証情報を、ステップ by ステップで取得します。

---

## ✅ 全体マップ

| # | 何 | 所要 | 必須 |
|---|---|---|---|
| 1 | **Google Drive Service Account** | 15分 | 🔴 (Routine 連携用) |
| 2 | **Pexels API key**（無料・登録のみ） | 5分 | 🟡 (B-roll なくても fallback gradient で動く) |
| 3 | **YouTube OAuth refresh_token** | 30分 | 🔴 |
| 4 | **X (Twitter) API v2 tokens** | 20分 | 🔴 |
| 5 | **Instagram Cookie** | 10分 | 🔴 |
| 6 | **TikTok Cookie** | 10分 | 🔴 |
| 7 | GitHub Secrets に登録 | 10分 | 🔴 |

すべて完了 ≈ **1.5〜2時間**。順番に進めれば確実に終わる。

---

## 1. Google Drive Service Account（15分）

Routine が保存した結果を Actions が取得するため。

### 手順
1. https://console.cloud.google.com を開く
2. プロジェクト「Daily World 60」を作る（新規）
3. APIs & Services → Library → **Google Drive API** を有効化
4. APIs & Services → Credentials → **Create Credentials** → **Service Account**
   - Name: `dailyworld60-actions`
   - 役割: なし（必須でない）
5. 作成後、その Service Account をクリック → **Keys** タブ → **Add Key** → **JSON** → ダウンロード
6. ダウンロードした JSON を控える（GitHub Secret に貼る）
7. **Drive 側**で「Daily World 60」フォルダを Service Account の email（`xxx@xxx.iam.gserviceaccount.com`）に **編集者として共有**

### GitHub Secret 名
```
GOOGLE_SERVICE_ACCOUNT_JSON = <JSON 全文をそのまま貼る>
```

---

## 2. Pexels API key（5分）

### 手順
1. https://www.pexels.com/api/ → Sign up
2. ダッシュボードで API Key を取得

### GitHub Secret 名
```
PEXELS_API_KEY = <key>
```

---

## 3. YouTube OAuth refresh_token（30分）

### 手順

#### 3-A. GCP プロジェクトで OAuth 設定
1. https://console.cloud.google.com → 同じプロジェクト
2. APIs & Services → Library → **YouTube Data API v3** を有効化
3. APIs & Services → OAuth consent screen
   - User Type: External
   - App name: "Daily World 60"
   - Test users: あなたの Google アカウント（@60dailyworld のチャンネルを管理するアカウント）
4. APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Name: "DW60 CLI"
5. Client ID と Client Secret を控える

#### 3-B. refresh_token を取得（ローカルで1回だけ）

ローカル Mac で：

```bash
cd ~/.company/affiliate/automation/shorts-pipeline
npx tsx scripts/auth/get-youtube-refresh-token.ts \
  <CLIENT_ID> <CLIENT_SECRET>
```

ブラウザが開く → @60dailyworld を管理する Google アカウントでログイン → 許可

ターミナルに refresh_token が表示される → 控える

### GitHub Secrets
```
YOUTUBE_CLIENT_ID     = <clientId>
YOUTUBE_CLIENT_SECRET = <clientSecret>
YOUTUBE_REFRESH_TOKEN = <refreshToken>
```

---

## 4. X (Twitter) API v2 tokens（20分）

### 手順
1. https://developer.x.com → Apply for an account（Free tier、月1,500投稿無料）
2. Project & App を作成（Name: "Daily World 60"）
3. App settings → **User authentication settings**:
   - App permissions: **Read and write**
   - Type of App: **Web App, Automated App or Bot**
   - Callback URL: `http://localhost:3000/callback`
4. **Keys and Tokens** タブで以下を取得:
   - API Key (Consumer Key)
   - API Secret (Consumer Secret)
   - **Access Token** と **Access Secret**（"Generate" ボタン）

### GitHub Secrets
```
X_API_KEY        = <consumer key>
X_API_SECRET     = <consumer secret>
X_ACCESS_TOKEN   = <access token>
X_ACCESS_SECRET  = <access secret>
```

---

## 5. Instagram Cookie（10分）

### 手順（Chrome で @60dailyworld にログインした状態で）

1. https://www.instagram.com を開いて @60dailyworld でログイン
2. F12（DevTools）→ Application → Cookies → `https://www.instagram.com`
3. **EditThisCookie** 拡張機能 をインストール (Chrome Web Store)
4. ツールバーの EditThisCookie アイコン → **Export** → JSON コピー
5. ターミナルで base64 化:
   ```bash
   pbpaste | base64 | pbcopy
   ```

### GitHub Secret
```
INSTAGRAM_COOKIES_B64 = <base64 string>
```

### 注意
- Cookie は **数ヶ月** で期限切れ。失効したら再取得
- 2段階認証してても Cookie 経由なら通る

---

## 6. TikTok Cookie（10分）

### 手順
1. https://www.tiktok.com/login で @60dailyworld にログイン
2. EditThisCookie で `https://www.tiktok.com` の Cookie をExport
3. base64 化（上と同様）

### GitHub Secret
```
TIKTOK_COOKIES_B64 = <base64 string>
```

---

## 7. GitHub Secrets に登録（10分）

1. https://github.com/HeroCramSchool/daily-world-60/settings/secrets/actions
2. **New repository secret** を押して、上記の各 Secret 名と値を登録

合計 9 個:
- GOOGLE_SERVICE_ACCOUNT_JSON
- PEXELS_API_KEY
- YOUTUBE_CLIENT_ID
- YOUTUBE_CLIENT_SECRET
- YOUTUBE_REFRESH_TOKEN
- X_API_KEY
- X_API_SECRET
- X_ACCESS_TOKEN
- X_ACCESS_SECRET
- INSTAGRAM_COOKIES_B64
- TIKTOK_COOKIES_B64

---

## ✅ 動作確認

GitHub の Actions タブで `Daily World 60 — Publish` を選び、**Run workflow** で手動実行。
`dry_run: true` で投稿せず生成だけテスト可能。

```
Actions タブ → Daily World 60 — Publish → Run workflow → Run
```

ログで各 Step の成功/失敗を確認。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON not set` | Secret 未登録 | 1 をやり直し |
| Drive "Daily World 60" not found | Service Account に共有されていない | フォルダを SA email に編集者で共有 |
| YouTube 403 | OAuth スコープ不足 | 上の手順で取り直し（youtube.upload scope 必須） |
| X 401 | tokens 取り違え | Access Token と Consumer Token を混同していないか確認 |
| IG 投稿失敗（DOM 変更） | IG UI 更新 | publishers/instagram.ts のセレクタ修正 |
| Cookie 期限切れ | 数ヶ月経過 | 5/6 をやり直し |

---

## 最低限の構成（緊急 MVP）

時間ない時は以下だけ取得：

1. ✅ GOOGLE_SERVICE_ACCOUNT_JSON（Drive 連携）
2. ✅ YOUTUBE_* (3つ、最大プラットフォーム)
3. ✅ X_* (4つ、日本語投稿)
4. ⏭ Instagram / TikTok は後回し（→ skip して continue）

これだけでも YouTube + X は完全自動化される。
