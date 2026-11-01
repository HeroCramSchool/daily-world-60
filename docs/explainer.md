# 解説形式の本編（news-explainer-2026-11）

本編を、確かめた事実だけで組む約30秒の解説に作り直す。ナレーション（Kokoro）は今のまま。絵は AI 画像をやめ、データから描く図（地図の寄り・数のカウンター・棒・矢印・引用カード）にする。
計画と判断の経緯: `docs/plans/news-explainer-plan-2026-11-01.html`（2026-11-01 オーナー承認）。

- 台本は Claude API（Opus 5.5・web search / web fetch）が書く。事実の文はそれぞれ、取得したニュースのページの文を1つそのまま引用する。
- コード（`checkFacts`）が、読み上げる数・図の数・地名がすべて引用文にあるかを照合する（下の「照合の決まり」）。続けて別の Claude 呼び出しが反証を試みる。直すのは1回まで。
- 通らなかった本は、その日は今の形式で作る。投稿は止めない。
- 題材は今までどおり Routine が選ぶ。新旧で題材の選び方は同じ。

## 出典にする媒体

- `infrastructure/claude/outlets.ts` の15媒体だけ（ABC News は abcnews.go.com と転送先の abcnews.com の2ドメインなので、一覧は16ドメイン）。web search / web fetch の `allowed_domains` と照合の両方に同じ一覧を使う。国営の宣伝媒体は入れない。
- Anthropic のクローラーを断っている媒体は入れない（apnews.com・reuters.com・bbc.com など19媒体。入れると呼び出し全体が 400）。robots.txt で Claude-User / Claude-SearchBot を断っている媒体も入れない（cnn.com・npr.org・nbcnews.com・france24.com・haaretz.com・bloomberg.com。2026-11-01 確認）。
- web fetch で取れなかった Routine の出典を自前の HTTP で取り直すのは、robots.txt が Claude-User（無ければ `*`）に許しているときだけ。robots.txt を読めなければ取らない。
- 画面の「SOURCE ·」と説明欄の `Sources:` の媒体名は、書き手ではなくコードが URL から決める（`OUTLET_NAMES`）。
- 本文から関連記事を落としてから、書き手と照合に渡す。「Read also:」「Related」「More」などの見出しの行、Al Jazeera の「list N of M」、Japan Times の「WHAT’S TRENDING」「Editors' Picks」、1行まるごとリンク1本の行。HTML では関連記事のカード・リンク1本だけの li/div と、本文を選ぶ前の aside・nav も落とす。

## 照合の決まり（checkFacts）

- 引用文は、取得した本文の中に語の区切りどおりにあること（語の途中で切った引用は誤り）。否定や主張者を落とした断片はコードでは止めず、反証で見る。
- 読み上げる数はすべて、その行の引用文にあること。カウンターの数と引用カードの who の数も、その行の引用文から。棒の数は、その行の引用文か、ほかの事実の文で読み上げた数。`40%`・`40 percent` は 40% として扱い、ただの 40 とは別。F-16・Shahed-136 のような型番は数ではなく名前で、文に書いたら引用文にも同じ型番が要る（end-2026・Category-5 のような区分の語の後の数字は数として扱う）。序数（third→3）と、倍数・増減の語（twice・doubled・halved など）も引用文と照らす。
- 見出しは数字で始める。前に置けるのは、引用文が数に付けた修飾語（around・about・nearly・almost・over・more than・at least・up to・some・approximately・roughly・an estimated・as many as）と、数字の直前の通貨記号（$・US$・A$・C$・€・£・¥）だけ。見出しと framing の文の数は、事実の文で確かめた数だけ。
- 公開日時が分かる事実は、どれも48時間より古ければ誤り。検索の page_age は「最終更新」なので、古いと分かったときにだけ使う。
- 引用カードは事実の文だけに置ける。札の言葉が出典の本文で引用符の内側にある（本人の発言。引用文に開きの引用符を写していなくてもよい）か、who が出典の媒体名のとき（媒体の地の文）だけ通る。
- 時刻・日付・範囲の端の数・通貨と符号は、数字だけで照らしている（反証の側で確かめる）。

## 地図

- 解説形式の地図は実際の地図（国境・海岸線・川・湖・国名・海の名）。今の形式の点の地図（`scripts/lib/mapscene.ts`）は比較中は変えない。
- 描くのは `scripts/lib/realmap.ts`。データは `assets/realmap/`（Natural Earth v5.1.2・パブリックドメイン）。国境は米国視点版（クリミア・ドネツクはウクライナ、コソボは独立国、ゴラン高原はイスラエル）。オーナーが 2026-11-01 に選んだ。標準版はクリミアをロシア領に描くので使わない。
- 地名の座標は Routine の mapMarkers → Wikipedia の座標の順（`scripts/lib/geocode.ts`）。Wikipedia は先に「地名, 国名」（例: Hyderabad, Pakistan）の記事を引き、無ければ地名だけで引く。どちらも国の中心から遠すぎれば捨てる。
- 地名がどれも座標にならなければ、国の中心に国名の点を1つ打つ。国も引けなければ点を打たず、mapMarkers の範囲（無ければ世界）を映す。本を今の形式に戻さない。
- Routine は世界全体の話に `GL` と 🌍 を使う。そのときはどの国も塗らない（Greenland の旗 🇬🇱 の本だけ Greenland を塗る）。
- 作り直すとき: Natural Earth の GeoJSON（`ne_10m_admin_0_countries_usa`・`ne_50m_rivers_lake_centerlines`・`ne_50m_lakes`・`ne_50m_geography_marine_polys`）を取り、mapshaper で `-filter-fields ADM0_A3,ISO_A2_EH,NAME_EN -simplify 12% keep-shapes`（国境）、川と湖は scalerank で絞って `-simplify 30%`、海は `-points inner` にして TopoJSON / GeoJSON で書き出す。`scripts/lib/realmap.test.ts` が視点の取り違えを止める。

## 描画（remotion/src/explainer）

- 0 フレーム目に見出しと最初の図を出す（フィードのサムネ代わり）。最後の約0.6秒は見出しに戻り、頭へループする。
- 見出しの文字サイズは `HookCard.tsx` が Inter 900 の実測の字幅表で決める（切れて隠れる行を出さない）。フォントや字間を変えたら表を測り直す。
- カウンターと棒の数は台本の数を丸めずに出す。語の無い文は図も効果音も出さない。
- 確かめ方: `npm run test:explainer`、見本は `npx tsx remotion/fixtures/make-explainer-fixture.ts` のあと `cd remotion && npx remotion still ExplainerPreview <png> --frame=N`。

## 毎日の流れ（publish.yml）

| 段 | やること |
|---|---|
| Step A | Routine の台本を Drive から取る → `script-en.json`（変更なし） |
| Step A2（新） | `scripts/write-explainers.ts`。本ごとに形式を決め、解説形式なら 調べる → 書く → 照合 → 反証。全体の締め切り12分・`continue-on-error`・段の上限15分 |
| Step B | 本ごとのナレーション（変更なし） |
| Step B2r | AI 画像。storyboard のある本では写真・AI hero・モーション（有料の fal・runpod を含む）を作らない。作るのは単色の下地と国旗、それに今の形式に戻ったとき用の無料のビート画像（Pollinations）だけ |
| Step Cr | `prep-short.ts`。使える storyboard のある本は解説形式、ほかは今の形式で描く |
| Step F2 | 投稿。解説形式で描いた本は、YouTube のタイトルと台帳の hookText を storyboard の見出しにし、説明欄に `Sources:`（媒体ごとに1つ・最大3つ）と図の注記を足す。台帳に `style` を残す |

ファイルは `$OUT_DIR`（cron では `output/<台本日>-b1`）に置かれる。`experiment-arms.json` 以外の3つは実行画面の Artifacts にも入る。

- `storyboard-<投稿順>-<国コード>.json` … 照合と反証に通った台本（型は `domain/storyboard/Storyboard.ts`）。これがある本だけ解説形式になる
- `explainer-status.json` … 本ごとの結果。キーは投稿順。`status`・`errors`・`costUsd`
- `claude-usage.json` … その実行で Claude に使った量と費用。`estimated: true` の行は、失敗・中断した呼び出しを押さえた見込み額で記録したもの（実測ではない）
- `experiment-arms.json` … prep-short が書く、本ごとの施策・腕・`style`。publish-all がこれを台帳 posted-ledger.json に写す。照合と反証に通った台本があったのに描画で今の形式に戻った本には `fallback: "render"` が付く（腕は割り付けたまま）

## status の意味

| status | 意味 | 作った形式 | A/B での扱い |
|---|---|---|---|
| `ok` | 照合と反証に通った | 解説形式 | 解説形式の腕 |
| `not_assigned` | 解説形式に決まらなかった | 今の形式 | 割り付けで今の形式になった本は、今の形式の腕 |
| `no_docs` | 出典のページを取れなかった | 今の形式 | 解説形式の腕に数える |
| `check_failed` | 照合の誤りが直しても消えなかった | 今の形式 | 解説形式の腕に数える |
| `refuted` | 反証で誤りが見つかった | 今の形式 | 解説形式の腕に数える |
| `refusal` | Claude が書くのを断った | 今の形式 | 解説形式の腕に数える |
| `incomplete` | 試みた後に止まった。その本の呼び出しが1回でも返った後の失敗（全体の締め切り・本の予算切れ・max_tokens・反証の JSON を読めない・API の誤り）、最初の呼び出しの段の時間切れ、本ごとのコードの誤り | 今の形式 | 解説形式の腕に数える |
| `disabled` | 試みなかった（キーが無い など） | 今の形式 | 比較から外す |
| `cap` | 最初の呼び出しの前に、本の予算を1回の実行の上限に収められなかった（投稿順に押さえる） | 今の形式 | 比較から外す |
| `api_error` | 最初の呼び出しが返る前の API の障害（接続の誤り・400・401・403・429・5xx・529）・全体の締め切り。設定の誤り（400 など）にも気づけるよう、Actions のログに誤りの印（::error::）を付ける | 今の形式 | 比較から外す |

外すのは、中身を見る前に決まる `disabled`・`cap`・`api_error` だけ。途中で止まった本（`incomplete`）は解説形式の腕に数える。最初の呼び出しの段の時間切れは、調べる量（本の中身）で決まりうるので数える。最初の呼び出しの 400 は媒体の一覧などの設定の誤りでほぼ全本に起きるので外す。決まりは `finalizeArmRecord`（`domain/storyboard/ExplainerArm.ts`）にある。Step A2 が status を書く前に落ちた本も外す。手動の `explainer`=on/off で作った本も外す。

## 設定（オーナーがやること）

1. GitHub の secret に `ANTHROPIC_API_KEY` を入れる: https://github.com/HeroCramSchool/daily-world-60/settings/secrets/actions → New repository secret。入れるまでは全本が `disabled` で今の形式になる（投稿は止まらない）。
2. Anthropic Console で月の利用上限（spend limit）を掛ける。11/21 の販促クレジット失効の後も API で続ける（2026-11-01 オーナー判断）ので、ここが月の歯止めになる。Console の画面の名前は確かめていない。
3. 任意: 上限を変えるなら Variables に `EXPLAINER_DAILY_CAP_USD`（既定 4 ドル）・`EXPLAINER_STORY_CAP_USD`（既定 1.2 ドル）を入れる: https://github.com/HeroCramSchool/daily-world-60/settings/variables/actions

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `EXPLAINER` | 空 | 空=施策台帳で決める・`on`=全部を解説形式・`off`=全部を今の形式。手動実行の入力 `explainer`（auto/on/off）から入る。ffmpeg 経路は常に `off` |
| `ANTHROPIC_API_KEY` | なし | secret から Step A2 だけに渡す |
| `EXPLAINER_DAILY_CAP_USD` | 4 | 1回の実行の上限（目安）。本ごとの予算を投稿順に最初に押さえ、収まらない本は呼ばずに `cap` |
| `EXPLAINER_STORY_CAP_USD` | 1.2 | 解説形式の本1本の予算。使い切ったら `incomplete` |
| `EXPLAINER_DEADLINE_SEC` | 720 | Step A2 全体の締め切り（秒） |

上限は実行ごとに数える（Actions は毎回まっさらで、`claude-usage.json` もその実行の分だけ）。本は同時に走るので、本ごとに呼び出し1回が見込みを超えた分（最大で本の数ぶん）だけ上限を超えうる。失敗した呼び出しは見込み額で記録するので、実額はこれより多いことがある（Console の利用額と突き合わせる）。同じ日に手動で何度も回すと合計は上限を超えうるので、月の歯止めは Console の上限で掛ける。本ごとの見込み額（調べる 0.5・書く 0.15・反証 0.15）と 1.2 ドルは実測ではない。初回の実行の `claude-usage.json` で決め直す。

## 11/5 より前に見る

1. Actions → 「Daily World 60 — Publish」→ Run workflow。
2. `mode`=preview、`explainer`=on、`date` は空（当日・UTC）、`batch`=1。Routine の台本ができる 18:00 UTC 以降に回す。
3. 終わったら実行画面の Artifacts「dailyworld60-<日付>-b1」を開く。`news-*.mp4`・`storyboard-*.json`・`explainer-status.json`・`claude-usage.json` が入っている。

preview は投稿しないので、台帳にも A/B にも残らない。Drive にも上がらない（preview では publish-results.json ができないので、Drive へのアップロードの段が何もしない）。Claude の費用はかかる。

## A/B の数え方

- 期間: 台本日 2026-11-05〜11-18。判定日 11-26（最終日の動画が7日たつのを待つ）。
- 割り付け: 本ごとに「施策 id・台本日・投稿順」のハッシュで解説形式か今の形式かを決める。今の台帳で計算すると14日×3本は解説形式22本・今の形式20本（11/9 は3本とも今の形式、11/18 は3本とも解説形式）。
- 比と区間は、両方の形式がそろった日だけで日ごとの比（log(再生+1) の平均の差）を出し、日で平均する。11/9・11/18 のように片方しか無い日と、片側だけ比較から外れた日は比に入らない。中央値の比は全期間をまとめたまま。
- 数えるのは台帳の `exp` / `arm`（割り付けた腕）。`style` は実際に描いた形式の記録で、判定には使わない。
- 判定（毎日・stats.yml の `pdca readout`）: 投稿7日後の再生で比べる。採用の基準は「幾何平均の比1.0以上かつ中央値の比1.0以上」。不採用の基準は「比0.7未満」。目的が「悪くならないなら替える」なので、ふだんの採用の基準（比1.3）より低い。
- 止める条件は「投稿48時間後の再生で、解説形式が10本以上たまり、48時間後の中央値の比が0.5未満」（`nT48>=10 && medRatio48<0.5`）。7日後の再生だと最も早くて11/20になり、期間の後になるため。今の割り付けでは、最も早く当たりうるのは 11/15 17:30Z の判定で、その時点で未投稿の解説形式は9本（11/15〜18）。除外があれば遅れる。当たると GitHub Issue「[PDCA] news-explainer-2026-11: 停止条件」が立つ。止めるかはオーナーが決める（下の「止める」）。
- 1群21本で見分けられる差は約3.4倍（`npm run pdca -- check`）。小さな差は見えないので、判定は「悪くないか」を見るものと考える。

## 止める・採用する

- 止める: `experiments/registry.json` の `news-explainer-2026-11` を `"status": "stopped"` にし、`decision`（result・action・by・on・learning）を書いて `npm run pdca -- learnings`、PR をマージする。次の実行から全本が今の形式になる。
- すぐ止めたいとき: secret の `ANTHROPIC_API_KEY` を消す。全本が `disabled` で今の形式になる（この間の本は比較から外れる。比は日ごとに比べるので、解説形式の無い日は比に入らず偏らない）。手動実行なら `explainer`=off。
- 採用する（11/26）: `"status": "adopted"` と `decision` を書く。期間の後も全本が解説形式になる（write-explainers・prep-short・publish-all は採用済みの施策も見る）。

## 費用

計画書の見込み: 1日 約0.7ドル。11/21 の後は月 20〜30ドル。どちらも実測ではない。初回の実行のあと、`claude-usage.json` の実測でここを埋める。

| 日付 | 解説形式を試みた本 | ok | 費用（ドル） |
|---|---|---|---|
| （初回の実行の後に記入） | | | |

## 残っていること

- 描画（render-shorts.mjs）で解説形式の1本が落ちると、その日の3本とも出ない。落ちる原因として見つけた経路（文が1つ以下のとき）は直した。
- YouTube のカスタムサムネと IG・TikTok の表紙（generate-social-images.ts）は、解説形式の本でも Routine の hookText から作る。
- 題材を選ぶ編集担当（Claude）は、採用の後に足す。比較中は Routine が選ぶ。
