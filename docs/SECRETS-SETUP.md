# Secrets セットアップ / GCP 復旧ガイド — Daily World 60

GitHub Actions (`.github/workflows/publish.yml`) が 4 プラットフォームへ投稿するための認証情報。
**実態に合わせて記載**（X は API v2 ではなく Cookie、Drive は SA 鍵ではなく WIF キーレス）。

---

## ✅ 全体マップ（publish.yml が実際に使う Secret）

| # | 何 | 用途 | 必須 | GitHub Secret 名 |
|---|---|---|---|---|
| 1 | **GCP Workload Identity (WIF)** | Drive から台本取得 / 結果アップロード | 🔴 | `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT` |
| 2 | Pexels API key | B-roll 補助（無くても Wikimedia + gradient で動く） | 🟡 | `PEXELS_API_KEY` |
| 3 | YouTube OAuth | YT Shorts 投稿 | 🟡※ | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` |
| 4 | Gmail OAuth | Cookie 認証時のメール確認コード自動取得 | 🟡 | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| 5 | X Cookie (base64) | 日本語スレッド投稿 | 🔴 | `X_COOKIES_B64` |
| 6 | Instagram Cookie (base64) | Reels 投稿 | 🔴 | `INSTAGRAM_COOKIES_B64` |
| 7 | TikTok Cookie (base64) | 動画投稿 | 🔴 | `TIKTOK_COOKIES_B64` |

※ YouTube はチャンネル `@60dailyworld` の**電話認証**が未済だと `thumbnails.set` が弾かれる（動画 upload 自体は通る・サムネは自動生成にフォールバック）。スケジュールの auto-publish では既定で YouTube をスキップしている。

---

## 1. GCP Workload Identity（WIF・キーレス）

`publish.yml` の最初のステップ `Authenticate to Google Cloud (WIF, keyless)` がこれを使う。
**このステップは全 run(preview/full)の必須前提**。プロジェクトが停止していると token 交換に失敗し、ジョブ全体がここで中断する（＝過去に preview すら回らなかった原因はこれの可能性が高い）。

### 1-A. 新規セットアップ / 復旧の共通手順

```bash
# 変数（適宜変更）
export PROJECT_ID=daily-world-60
export PROJECT_NUM=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export SA=dailyworld60-actions@$PROJECT_ID.iam.gserviceaccount.com
export REPO=HeroCramSchool/daily-world-60
export POOL=github-pool
export PROVIDER=github-provider

# APIs 有効化
gcloud services enable drive.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com --project $PROJECT_ID

# サービスアカウント（無ければ作成）
gcloud iam service-accounts create dailyworld60-actions --project $PROJECT_ID || true

# Workload Identity Pool + GitHub OIDC provider
gcloud iam workload-identity-pools create $POOL --location=global --project $PROJECT_ID || true
gcloud iam workload-identity-pools providers create-oidc $PROVIDER \
  --location=global --workload-identity-pool=$POOL --project $PROJECT_ID \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'" || true

# この repo の Actions が SA を借用できるようバインド
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT_ID \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"

# 出力: GitHub Secret に貼る値
echo "WIF_PROVIDER = projects/$PROJECT_NUM/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "WIF_SERVICE_ACCOUNT = $SA"
```

### 1-B. Drive フォルダ共有
Google Drive の「Daily World 60」フォルダを、上記 SA の email（`dailyworld60-actions@…iam.gserviceaccount.com`）に **閲覧者（取得のみなら）／編集者（結果アップロードもするなら）** で共有する。

### 1-C. GCP プロジェクト復旧（停止していた場合）
Google から "project has been shut down" 通知が来た時：
1. https://console.cloud.google.com/cloud-resource-manager → 対象プロジェクトが「削除保留」なら **復元（RESTORE）**（30 日以内なら可）。
2. 課金が原因なら **Billing** を再リンク。
3. 復元後、上の 1-A を流し直す（Pool/Provider/SA が消えていれば再作成。`|| true` 付きなので冪等）。
4. 1-B の Drive 共有を再確認。
5. GitHub Secrets の `WIF_PROVIDER` / `WIF_SERVICE_ACCOUNT` を新しい値で更新。
6. Actions タブで `Daily World 60 — Publish` を `mode=preview` で手動実行し、認証ステップが通ることを確認。

---

## 2. Pexels API key（任意）
https://www.pexels.com/api/ で取得 → `PEXELS_API_KEY`。無くても背景は Wikimedia Commons + gradient で動く。

---

## 3. YouTube OAuth refresh_token
GCP の同プロジェクトで **YouTube Data API v3** 有効化 → OAuth クライアント(Desktop) 作成 → ローカルで 1 回だけ：

```bash
cd ~/.company/affiliate/automation/shorts-pipeline
npx tsx scripts/auth/get-youtube-refresh-token.ts <CLIENT_ID> <CLIENT_SECRET>
```
ブラウザで `@60dailyworld` 管理アカウントにログイン → 許可 → 表示された refresh_token を控える。

```
YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN
```
> サムネ設定が要るなら youtube.com/account_advanced でチャンネルの電話認証を済ませる。

---

## 4. Gmail OAuth（Cookie 認証のメールコード自動取得用）
IG/TikTok/X のログイン確認コードがメールに来た時の自動取得に使う。OAuth(Desktop) を作り、Gmail 読み取りスコープで refresh_token を取得 → `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN`。

---

## 5〜7. Cookie 3 種（X / Instagram / TikTok）

**X は API v2 ではなく Cookie ベース**（Playwright で `x.com/compose/post` を操作）。3 種とも同じ手順：

### 取得（Chrome で各アカウントにログイン済みの状態で）
ローカルのヘルパーが Gmail コード自動入力込みで取得・base64 化してくれる：
```bash
cd ~/.company/affiliate/automation/shorts-pipeline
npx tsx scripts/auth/get-sns-cookies.ts          # 対話的に各プラットフォームの cookie を取得
# → ~/.config/dailyworld60/{x,instagram,tiktok}-cookies.b64 を生成
```
手動でやる場合は EditThisCookie 等で JSON エクスポート → `pbpaste | base64 | pbcopy`。

### GitHub Secrets
```
X_COOKIES_B64 / INSTAGRAM_COOKIES_B64 / TIKTOK_COOKIES_B64 = <base64 文字列>
```

### 注意
- Cookie は数週間〜で失効。失効すると publisher は **「login へ redirect」を検出して即エラー**を返す（無言タイムアウトにはならない）。その時は `get-sns-cookies.ts` で取り直し。
- 必要な鍵: X=`auth_token`+`ct0` / IG=`sessionid`+`ds_user_id`+`csrftoken`+`mid` / TikTok=`sessionid`+`sid_guard`。

---

## 8. GitHub Secrets 登録
https://github.com/HeroCramSchool/daily-world-60/settings/secrets/actions → New repository secret。

必須セット（最低限ライン）:
- `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`（Drive 連携・無いと全 run 停止）
- `X_COOKIES_B64`, `INSTAGRAM_COOKIES_B64`, `TIKTOK_COOKIES_B64`
- （任意）`YOUTUBE_*`, `GMAIL_*`, `PEXELS_API_KEY`

---

## 9. 動作確認 / 運用
- **生成だけ試す**: Actions → `Daily World 60 — Publish` → Run workflow → `mode=preview`。
- **実投稿**: 同じく `mode=full`（生成+投稿）または `mode=publish`（既存 preview を投稿）。
- **スケジュール**:
  - `18:30 UTC` cron … preview のみ（投稿しない）
  - `20:00 UTC` cron … **auto-publish (full)**。YouTube は既定スキップ。止めたい場合は publish.yml の該当 cron 行を削除。

---

## トラブルシューティング
| 症状 | 原因 | 対処 |
|---|---|---|
| 認証ステップで即失敗 / token 交換エラー | GCP プロジェクト停止 or WIF 設定ズレ | §1-C で復旧 → Secret 更新 |
| `Drive "Daily World 60" not found` | SA にフォルダ未共有 | §1-B で SA email に共有 |
| IG `checkpoint/challenge detected` | アカウントに確認要求 | 手動でブラウザ確認 → cookie 取り直し |
| publisher `login へ redirect` | cookie 失効 | `get-sns-cookies.ts` で再取得 |
| YouTube サムネ 403 | チャンネル電話認証未済 | account_advanced で認証 or 自動サムネ運用 |
| IG/TikTok 投稿失敗 (DOM 変更) | プラットフォーム UI 更新 | publishers/*.ts のセレクタ修正（失敗時 `*-fail-*.png` スクショ参照） |
