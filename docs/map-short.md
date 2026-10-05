# Map Short（「各国の○○」塗り分け地図 1 枚・5〜9 秒・無音）

海外調査（hero-cram-school/docs/research/youtube-overseas-rising-2026-10-05.md の P1）の持ち込み。
60 秒本編とは別枠で、月・水・金に 1 本ずつ投稿する。根拠: GeoX 442K（登録 1.1K）ほか 4ch・3 言語で再現、日本では 5〜9 秒型が空いている。

## ファイルの持ち分
- `content/maps/countries.json` … REST Countries のスナップショット（cca2/cca3/ccn3/name/region/subregion/landlocked/car.side/startOfWeek/timezones/currencies/area/population/unMember）＋ `source`/`fetchedAt`
- `content/maps/registry.json` … 地図の定義（下記）。データは **実データのみ**。出典 URL・年・取得日を必ず持つ
- `content/maps/posted.json` … 投稿済み台帳 `{ posted: [{ id, date, videoId, url }] }`（ワークフローがコミットして戻す）
- `remotion/src/map/MapShort.tsx` ほか … 描画。`remotion/props-map.json`（gitignore）を読む
- `remotion/prep-map.ts <mapId>` … registry + countries → `remotion/props-map.json`
- `scripts/publish-map.ts <mapId|auto>` … 次の未投稿を選び、prep → render → YouTube 投稿 → posted.json 追記（`DRY_RUN=1` で投稿しない）
- `.github/workflows/map-short.yml` … cron `0 0 * * 1,3,5` ＋ workflow_dispatch（map_id / dry_run）

## registry.json
```json
{
  "maps": [
    {
      "id": "driving-side",
      "title": "THE SIDE OF THE ROAD EACH COUNTRY DRIVES ON",
      "shortTitle": "Driving side in each country",
      "cta": "Your country? 👇",
      "legend": [ { "key": "left", "label": "Left", "color": "#FF5A4E" }, { "key": "right", "label": "Right", "color": "#3B82F6" } ],
      "data": { "JPN": "left", "USA": "right" },
      "unknownLabel": "No data",
      "source": { "name": "REST Countries (car.side)", "url": "https://restcountries.com/", "year": 2026, "fetchedAt": "2026-10-05" },
      "notes": "verification: left-hand = 7x countries/territories (Wikipedia list agrees within ±3)",
      "durationSec": 7
    }
  ]
}
```
- `data` のキーは ISO 3166-1 alpha-3（cca3）。描画側は countries.json の `ccn3` で world-atlas の数値 id に変換する
- 数値指標（平均寿命など）は registry 側でビン分けした `key` にして保存。元の値は `raw` に残してよい

## props-map.json（描画入力）
```json
{ "fps": 30, "durationSec": 7, "title": "...", "shortTitle": "...", "cta": "...", "legend": [...],
  "byNumeric": { "392": "left", "840": "right" }, "unknownLabel": "No data",
  "sourceLine": "Source: REST Countries, 2026", "brand": "Daily World 60" }
```
- 1080×1920・30fps・無音。タイトル上段（2 行まで）、地図中央（world-atlas countries-110m、南極は除外、geoNaturalEarth1 を幅に合わせる）、凡例チップ＋件数、`cta`、最下段に出典行。最初の 1.2 秒でカテゴリ順に塗りが入り、以後は静止（ループ前提）
- 字幕・ナレーション・BGM は無し（調査根拠どおり無音）

## 投稿メタ
- title: `${shortTitle} 🌍 #shorts`（100 字以内）
- description: 地図の説明 1 行＋ `Source: <name> (<year>) <url>` ＋ `Map is schematic (Natural Earth 110m); borders and territories simplified.` ＋ 既存の channel 行
- tags: map, geography, world, countries, ${id の語}, shorts
- 台帳: posted.json に追記。Drive の posted-ledger.json にも `format: "map"` で追記できるなら追記（collect-stats で news と分けて集計するため）

## 測り方（調査レポート P1 の計画）
- 指標: 投稿 7 日後の再生数の中央値（map 枠）vs 同期間の 60 秒本編の中央値（現状 ≈ 80）。期待: map 枠が本編の 2 倍以上
- 窓: 10/7〜10/31 の 11 本。やめる条件: 11 本の中央値が本編以下、またはコメント 0 が 8 本以上
