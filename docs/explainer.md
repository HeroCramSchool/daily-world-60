# 解説形式の本編（news-explainer-2026-11）

本編を、確かめた事実だけで組む約30秒の解説に作り直す。ナレーション（Kokoro）は今のまま。絵は AI 画像をやめ、データから描く図（地図の寄り・数のカウンター・棒・矢印・引用カード）にする。
計画と判断の経緯: `docs/plans/news-explainer-plan-2026-11-01.html`（2026-11-01 オーナー承認）。

- 台本は Claude API（Opus 5.5・web search / web fetch）が書く。事実の文はそれぞれ、取得したニュースのページの文を1つそのまま引用する。
- コード（`checkFacts`）が、読み上げる数・図の数・地名がすべて引用文にあるかを照合する。続けて別の Claude 呼び出しが反証を試みる。直すのは1回まで。
- 通らなかった本は、その日は今の形式で作る。投稿は止めない。
- 題材は今までどおり Routine が選ぶ。新旧で題材の選び方は同じ。

## 地図

- 解説形式の地図は実際の地図（国境・海岸線・川・湖・国名・海の名）。今の形式の点の地図（`scripts/lib/mapscene.ts`）は比較中は変えない。
- 描くのは `scripts/lib/realmap.ts`。データは `assets/realmap/`（Natural Earth v5.1.2・パブリックドメイン）。国境は米国視点版（クリミア・ドネツクはウクライナ、コソボは独立国、ゴラン高原はイスラエル）。オーナーが 2026-11-01 に選んだ。標準版はクリミアをロシア領に描くので使わない。
- 地名の座標は Routine の mapMarkers → Wikipedia の座標の順（`scripts/lib/geocode.ts`）。国の中心から遠すぎる答えは捨てる。
- 作り直すとき: Natural Earth の GeoJSON（`ne_10m_admin_0_countries_usa`・`ne_50m_rivers_lake_centerlines`・`ne_50m_lakes`・`ne_50m_geography_marine_polys`）を取り、mapshaper で `-filter-fields ADM0_A3,ISO_A2_EH,NAME_EN -simplify 12% keep-shapes`（国境）、川と湖は scalerank で絞って `-simplify 30%`、海は `-points inner` にして TopoJSON / GeoJSON で書き出す。`scripts/lib/realmap.test.ts` が視点の取り違えを止める。

## 毎日の流れ（publish.yml）

| 段 | やること |
|---|---|
| Step A | Routine の台本を Drive から取る → `script-en.json`（変更なし） |
| Step A2（新） | `scripts/write-explainers.ts`。本ごとに形式を決め、解説形式なら 調べる → 書く → 照合 → 反証。`continue-on-error`・上限20分 |
| Step B | 本ごとのナレーション（変更なし） |
| Step B2r | AI 画像。storyboard のある本は飛ばし、単色の下地と国旗だけ置く |
| Step Cr | `prep-short.ts`。使える storyboard のある本は解説形式、ほかは今の形式で描く |
| Step F2 | 投稿。解説形式の本は YouTube の説明欄に `Sources:`（事実の文の媒体ごとに1つ・最大3つ）を足す。台帳に `style` を残す |

ファイルは `$OUT_DIR`（cron では `output/<台本日>-b1`）に置かれる。`experiment-arms.json` 以外の3つは実行画面の Artifacts にも入る。

- `storyboard-<投稿順>-<国コード>.json` … 照合と反証に通った台本（型は `domain/storyboard/Storyboard.ts`）。これがある本だけ解説形式になる
- `explainer-status.json` … 本ごとの結果。キーは投稿順。`status`・`errors`・`costUsd`
- `claude-usage.json` … その実行で Claude に使った量と費用
- `experiment-arms.json` … prep-short が書く、本ごとの施策・腕・`style`。publish-all がこれを台帳 posted-ledger.json に写す

## status の意味

| status | 意味 | 作った形式 | A/B での扱い |
|---|---|---|---|
| `ok` | 照合と反証に通った | 解説形式 | 解説形式の腕 |
| `not_assigned` | 解説形式に決まらなかった | 今の形式 | 割り付けで今の形式になった本は、今の形式の腕 |
| `no_docs` | 出典のページを取れなかった | 今の形式 | 解説形式の腕に数える |
| `check_failed` | 照合の誤りが直しても消えなかった | 今の形式 | 解説形式の腕に数える |
| `refuted` | 反証で誤りが見つかった | 今の形式 | 解説形式の腕に数える |
| `refusal` | Claude が書くのを断った | 今の形式 | 解説形式の腕に数える |
| `disabled` | 試みなかった（キーが無い など） | 今の形式 | 比較から外す |
| `cap` | 費用の上限に当たった | 今の形式 | 比較から外す |
| `api_error` | API の障害・時間切れ | 今の形式 | 比較から外す |

外す・数えるの決まりは `finalizeArmRecord`（`domain/storyboard/ExplainerArm.ts`）にある。Step A2 が status を書く前に落ちた本も外す。手動の `explainer`=on/off で作った本も外す。

## 設定（オーナーがやること）

1. GitHub の secret に `ANTHROPIC_API_KEY` を入れる: https://github.com/HeroCramSchool/daily-world-60/settings/secrets/actions → New repository secret。入れるまでは全本が `disabled` で今の形式になる（投稿は止まらない）。
2. Anthropic Console で月の利用上限（spend limit）を掛ける。11/21 の販促クレジット失効の後も API で続ける（2026-11-01 オーナー判断）ので、ここが月の歯止めになる。Console の画面の名前は確かめていない。
3. 任意: 1回の実行の上限を変えるなら、Variables に `EXPLAINER_DAILY_CAP_USD` を入れる（既定 2 ドル）: https://github.com/HeroCramSchool/daily-world-60/settings/variables/actions

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `EXPLAINER` | 空 | 空=施策台帳で決める・`on`=全部を解説形式・`off`=全部を今の形式。手動実行の入力 `explainer`（auto/on/off）から入る。ffmpeg 経路は常に `off` |
| `ANTHROPIC_API_KEY` | なし | secret から Step A2 だけに渡す |
| `EXPLAINER_DAILY_CAP_USD` | 2 | Step A2 が Claude に使ってよい上限（ドル） |

`EXPLAINER_DAILY_CAP_USD` は実行ごとに数える（Actions は毎回まっさらで、`claude-usage.json` もその実行の分だけ）。同じ日に手動で何度も回すと合計は上限を超えうるので、月の歯止めは Console の上限で掛ける。

## 11/5 より前に見る

1. Actions → 「Daily World 60 — Publish」→ Run workflow。
2. `mode`=preview、`explainer`=on、`date` は空（当日・UTC）、`batch`=1。Routine の台本ができる 18:00 UTC 以降に回す。
3. 終わったら実行画面の Artifacts「dailyworld60-<日付>-b1」を開く。`news-*.mp4`・`storyboard-*.json`・`explainer-status.json`・`claude-usage.json` が入っている。

preview は投稿しないので、台帳にも A/B にも残らない。Drive にも上がらない（preview では publish-results.json ができないので、Drive へのアップロードの段が何もしない）。Claude の費用はかかる。

## A/B の数え方

- 期間: 台本日 2026-11-05〜11-18。判定日 11-26（最終日の動画が7日たつのを待つ）。
- 割り付け: 本ごとに「施策 id・台本日・投稿順」のハッシュで解説形式か今の形式かを決める。同じ日の動画どうしで比べるので、ニュースの強さの差が打ち消し合う。今の台帳で計算すると14日×3本は解説形式22本・今の形式20本（11/9 は3本とも今の形式、11/18 は3本とも解説形式）。
- 数えるのは台帳の `exp` / `arm`（割り付けた腕）。`style` は実際に描いた形式の記録で、判定には使わない。
- 判定（毎日・stats.yml の `pdca readout`）: 投稿7日後の再生で比べる。採用の基準は「幾何平均の比1.0以上かつ中央値の比1.0以上」。不採用の基準は「比0.7未満」。目的が「悪くならないなら替える」なので、ふだんの採用の基準（比1.3）より低い。
- 止める条件は「解説形式が10本以上たまり、中央値の比が0.5未満」。当たると GitHub Issue「[PDCA] news-explainer-2026-11: 停止条件」が立つ。止めるかはオーナーが決める（下の「止める」）。
- 1群21本で見分けられる差は約3.4倍（`npm run pdca -- check`）。小さな差は見えないので、判定は「悪くないか」を見るものと考える。

## 止める・採用する

- 止める: `experiments/registry.json` の `news-explainer-2026-11` を `"status": "stopped"` にし、`decision`（result・action・by・on・learning）を書いて `npm run pdca -- learnings`、PR をマージする。次の実行から全本が今の形式になる。
- すぐ止めたいとき: secret の `ANTHROPIC_API_KEY` を消す。全本が `disabled` で今の形式になる（この間の本は比較から外れる）。手動実行なら `explainer`=off。
- 採用する（11/26）: `"status": "adopted"` と `decision` を書く。期間の後も全本が解説形式になる。

## 費用

計画書の見込み: 1日 約0.7ドル。11/21 の後は月 20〜30ドル。どちらも実測ではない。初回の実行のあと、`claude-usage.json` の実測でここを埋める。

| 日付 | 解説形式を試みた本 | ok | 費用（ドル） |
|---|---|---|---|
| （初回の実行の後に記入） | | | |
