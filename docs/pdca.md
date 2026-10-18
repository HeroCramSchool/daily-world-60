# DW60 の PDCA（施策台帳と自動判定）

施策は「台帳に登録 → 乱数で割り付け → 毎日の自動判定 → オーナーが決定 → 学びが台本作りへ」で回す。
2026-10-18 にオーナーが推奨案を承認して導入した（台帳は repo の JSON・採用基準は比1.3以上かつ下限0.8以上・知らせ方は GitHub Issue）。

## 1. P — 台帳に登録する（experiments/registry.json）

- 1件ごとに5点（根拠の数字・仮説・期待する効果・測り方・やめる条件）と、判定の決まり（`decide`）を **結果を見る前に** 書く。
- `status`: idea（候補）→ draft（書いた）→ running（割り付け中）→ 終わり（adopted / rejected / stopped）。
- `armSource`: `{"by":"hash"}` は乱数の割り付け（新しい施策はこれ）。`{"by":"field","field":"format|variant|rank|index"}` は動画の既存の項目をそのまま腕にする（比較・観察用）。
- `unit`: video（同じ日の中で腕が分かれる。日ごとのニュースの差が打ち消し合う）/ day / night。
- 判定の式（`adoptIf` / `rejectIf` / `stopIf`）で使える変数: `ratio`, `lo`, `hi`, `n`, `nT`, `nC`, `medT`, `medC`。省略時は台帳の `defaultDecide`。
- 登録したら `npm run pdca -- check`。見分けられる最小の差（`expectedPerArm` があれば）と、2倍・1.5倍を見るのに要る本数が出る。PR では `pdca-check.yml` が自動で検査する。

本数の壁（σ=1.41 のとき、有意水準5%・検出力80%）:

| 1群の本数 | 見分けられる最小の差 |
|---|---|
| 18本 | 3.7倍 |
| 60本 | 2.1倍 |
| 65本 | 2倍 |
| 190本 | 1.5倍 |

## 2. D — 割り付けと記録

- `domain/experiment/Assignment.ts` の `assignArm()` が、施策 id・台本日・投稿順から腕を決める。何度呼んでも同じ腕になる。日付の偶奇は使わない。
- 描画（`remotion/prep-short.ts`）と台帳記録（`scripts/publish-all.ts`）が同じ関数を呼ぶ。投稿した動画の `exp`（施策 id）と `arm`（腕）が posted-ledger.json に残り、`collect-stats.ts` が stats-history.json へ写す。
- 1フレーム目のレイアウトは、手動の `hook_layout` 入力 > 動いている hook 施策の腕 > legacy。

## 3. C — 毎日の自動判定（stats.yml の最後）

- `npm run pdca -- readout` が施策ごとに、投稿7日後の再生数（views@7d）の幾何平均の比と、日ごとに引き直した95%区間を出す。
- 同じ期間の本番の変更（git の履歴）・本編0本の日・投稿ワークフローの失敗・同時に動いている施策を「交絡の候補」として並べる。
- 結果は Drive の `experiments-report.md`（毎日上書き）と、実行画面の要約に出る。
- 判定日に来た施策・停止条件に当たった施策は、GitHub Issue「[PDCA] <id>: 判定待ち / 停止条件」を1件だけ立てる（同じ題が開いていれば立てない）。

## 4. A — オーナーが決める

1. Issue とレポートを見る。
2. `experiments/registry.json` のその施策の `status` と `decision`（result・action・by・on・learning）を書き、`npm run pdca -- learnings` で `experiments/learnings.md` を作り直す。下書きは Claude に頼める。
3. PR を作り、オーナーがマージする（マージがオーナーの承認）。Issue は閉じる。
4. 決まった学びは `winning-patterns.md` の「確定した学び」に載り、台本を作る Routine が読む。

判定不能は、変更の少ない側（元のまま）に倒す。

## 5. 週報（月曜）

月曜の stats.yml の回に `npm run pdca -- weekly` が Issue「PDCA 週報」へ、実行中・判定待ち・2週間以内の判定日・この1週間の変更と事故・候補を追記する。

## 手元で試す

```bash
npm run pdca -- check
npm run test:pdca
STATS_LOCAL_FILE=./stats-history.json STATS_OUT_DIR=/tmp/pdca PDCA_DRY=1 npm run pdca -- readout
PDCA_DRY=1 STATS_LOCAL_FILE=./stats-history.json npm run pdca -- weekly --force
```

`PDCA_TODAY=YYYY-MM-DD` を付けると、その日の判定として計算する。Actions では stats.yml を手動実行し、`pdca_dry` と `pdca_weekly` で同じ確認ができる。
