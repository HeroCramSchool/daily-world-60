# 地図の在庫づくり（scripts/build-map-library.ts）

地図枠（docs/map-short.md）は 10 枚を使い切り、10/30 から在庫切れで止まっている。このスクリプトで候補を作り、人が確かめてから `content/maps/registry.json` に足す。

## 役割の分け方

- **Claude**（`claude-opus-5-5`・Message Batches API・effort medium）: 見出し・CTA・凡例の言葉・ビンの切れ目と、使うかどうか（skip）を決める。見るのは指標名・定義・分布の要約（件数・パーセンタイル）だけで、国ごとの値は渡さない
- **スクリプト**: 値の取得（World Bank Indicators API v2・REST Countries v3.1 のデータファイル）、ビン分け、下の検査
- **人**: 候補を確かめて昇格させる

候補の題材は、スクリプト内の `CATALOG`（World Bank 指標 77 件と REST Countries 由来 8 件）に並べてある。指標コードは実行のたびに API で実在を確かめ、無いものは落とす。registry.json・posted.json と id か指標コードが重なる題材は送らない。

## 動かし方

API キーは repo の `.env` に `ANTHROPIC_API_KEY=...` で置く（`.env` は gitignore 済み。コミットしない）。使いすぎ防止の上限は Console で設定する。

```bash
cd ~/.company/affiliate/automation/shorts-pipeline
npx tsx scripts/build-map-library.ts --dry-run                 # API を呼ばない。送る本文を表示し、先頭 3 件を機械的な仕様で組んで output/map-library/ に書く
npx tsx scripts/build-map-library.ts --count 50                # 本番。content/maps/candidates.json を書く
npx tsx scripts/build-map-library.ts --batch-id msgbatch_...   # 待っている途中で止めたとき。結果は作成から 29 日取れる
npx tsx scripts/build-map-library.ts --spec-file specs.json    # Claude を使わず、手で直した仕様から組み直す
```

- バッチは多くが 1 時間以内に終わる（上限 24 時間）。30 秒ごとに進み具合を表示する（`--poll-sec` で変更）
- バッチ ID は `output/map-library/batch-<id>.json` にも残る。candidates.json を上書きしても、控えが `output/map-library/<日付>-<id>-candidates.json` に残る
- GitHub Actions で回すジョブは作っていない。回すなら workflow_dispatch のジョブを足し、`secrets.ANTHROPIC_API_KEY` を env に渡し、candidates.json を artifact で受け取る形になる

### 費用

Batch は標準の半額で、Opus 5.5 は入力 $2・出力 $10（100 万トークンあたり）。

- 入力: dry-run の本文で数えて 50 件で約 9.4 万トークン、約 $0.19
- 出力（思考を含む）: **未実測**。1 件 1〜3 千トークンなら $0.5〜1.5
- 上限: 全件が max_tokens（16,000）まで出た場合で約 $8.2

実行後に実際のトークン数と概算額を表示し、candidates.json の `usage` に残す。

## 検査

落ちた候補は candidates.json の `rejected` に、段階（stage）と理由つきで残る。

| 段階 | 検査 | ねらい |
|---|---|---|
| fetch | 指標コードが World Bank に実在する | 打ち間違いのコードを送らない |
| precheck | 値のある国・地域が 150 以上 | 灰色だらけの地図にしない |
| precheck | 2015 年より前の値は使わない。その国は No data になり、notes に列挙する | 古い値を最新のように見せない |
| claude | refusal・errored・expired・max_tokens・JSON でない | Batch では fallbacks が使えないので、落として理由を残す |
| skipped-by-model | Claude が skip を返した（国を順位づける題材、国境の争いなど） | 題材の線引きは prompts/maps/spec.md |
| checks | 数値は 3〜5 ビン、カテゴリは 2〜5 群。どの色も 8 か国以上 | 色が 1〜2 か国しかない凡例を出さない |
| checks | 凡例の数字は、そのビンの切れ目と同じ | 「50–100」なのに切れ目が 150、のずれを止める |
| checks | 見出し・CTA・補足に出る数字は、定義・指標名・切れ目・年に出てくるものだけ | Claude は国の値を知らないので、数字を作らせない |
| checks | 見出しは大文字 48 字以内、CTA は 40 字以内で絵文字つき、凡例は 22 字以内 | MapShort の枠に収める |

落とさずに `review[].warnings` に書くもの: 1 色が 60% を超える、最も多い年が 5 年以上前。

ビン分けは API の値そのままで行う。`raw` には有効 4 桁で残す。年が混ざる指標は descriptionNote に「Latest available year per economy (A–B).」を足す（prep-map.ts が出典行に「(latest available)」を付ける）。

## 人が確かめて registry.json に足す手順

1. candidates.json の `maps` を 1 件ずつ見る。`review[].warnings` と `notes`（年の内訳・最高と最低の 3 か国・使わなかった国）を読む
2. 3 か国を出典と照らす。`raw` の値と `data` のキーが合っているか見る
   ```bash
   curl -s "https://api.worldbank.org/v2/country/JPN/indicator/SP.DYN.TFRT.IN?format=json&date=2015:2026"
   ```
   REST Countries 由来（english-official など）は REST の誤りが過去にあった（VIR の通行側、KAZ のタイムゾーン）。Wikipedia などと突き合わせる
3. 描画して見る。prep-map.ts は `remotion/props-map.json` を上書きするので、控えを取って戻す
   ```bash
   mkdir -p /tmp/maps-review
   cp content/maps/countries.json /tmp/maps-review/
   cp content/maps/candidates.json /tmp/maps-review/registry.json
   cp remotion/props-map.json /tmp/maps-review/props-map.backup.json
   MAPS_DIR=/tmp/maps-review npx tsx remotion/prep-map.ts <id>
   cp remotion/props-map.json /tmp/maps-review/props-<id>.json
   cp /tmp/maps-review/props-map.backup.json remotion/props-map.json
   (cd remotion && npx remotion still MapShort /tmp/maps-review/<id>.png --props=/tmp/maps-review/props-<id>.json --frame=200)
   ```
4. 見出しや切れ目を直したいときは、`review[].spec` を写して直し、`--spec-file` で組み直す（Claude は呼ばない）。形は `{ "specs": [ { "dataset": "<CATALOG の id>", "title": ..., "bins": [...] } ] }`。カタログに無い World Bank 指標は `"dataset": "wb:<コード>", "id": "<新しい id>"` で使える
5. 昇格させる
   ```bash
   npx tsx scripts/build-map-library.ts --promote fertility-rate,electricity-access
   ```
   registry.json の末尾に足すだけで、既存の行は書き換えない。dry-run の候補と、登録・投稿済みの id は受け付けない。notes の「NOT yet human-verified…」は「Promoted <日付> with --promote after human review.」に置き換わる。どの国を何で照らしたかを notes に書き足す（既存の地図と同じ流儀）
6. コミットするのは registry.json。candidates.json のコミットは任意（確認の記録として残すなら入れる）。publish-map.ts は registry の並び順で未投稿の先頭を選ぶので、出したい順に昇格させる
