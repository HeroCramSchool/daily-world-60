# Map Short（「各国の○○」塗り分け地図 1 枚・ナレーションと BGM つき約15秒／ナレーション無しは5〜9秒）

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
- 1080×1920・30fps。タイトル上段（2 行まで）、地図中央（Natural Earth v5.1.2 の米国視点の国境を軽くした `remotion/public/maps/countries-ne-usa.json`、南極は除外、geoNaturalEarth1 を幅に合わせる）、凡例チップ＋件数、`cta`、最下段に出典行。最初の 1.2 秒でカテゴリ順に塗りが入り、以後は静止（ループ前提）
- ナレーション: registry の `narration` がある地図は読み上げる（2026-11-07 オーナー指示「ナレーションも入れてください」。それまでの10本は調査根拠どおり無音）
  - 文は言い回しだけを人が書き、件数と国名は差し込みで入れる: `{n:<凡例の key>}` = 画面の凡例チップと同じ件数、`{top}` / `{bottom}` = raw の最大・最小の国（`the United States` のように the を付ける）。手で書いた数が凡例・見出し・CTA・補足に無ければ止める（`scripts/lib/map-narration.ts`）
  - 声は本編と同じ Kokoro（失敗時 edge-tts）。音量は本編と同じ -14 LUFS にそろえる。塗りが入り始める 0.4 秒から読み、読み終わって 1 秒後に頭へループする
  - 画面: 地図と凡例の間に字幕（2 行まで・読んでいる語だけ黄色）。その文で読む凡例のチップを光らせ、`{top}` / `{bottom}` の国を白い線で囲む
  - 読み上げに失敗した日は、無音の地図（約7秒）を出す。説明欄の合成音声の開示行と、台帳の variant（`map-narrated` / `map`）は、実際に入ったかで決まる
  - ナレーションの有無で伸びが変わるかは、無音の10本と variant で比べる（本数が少ないので目安）
- BGM: 2026-11-08 オーナー指示「BGMもつけてください」。本編と同じ Kevin MacLeod（CC BY 4.0）の曲を、書き出し後に ffmpeg で重ねる（`scripts/lib/map-bgm.ts`、`publish-map.ts` から呼ぶ）
  - 曲は同じプールの地図の中での登録順で回す（ハッシュだと週3本では偏り、9本中6本が同じ曲になった）。見出しが軍事などの地図は `bgm-conflict`、ほかは `bgm`。曲の中の開始位置は日付で変わる
  - 声が鳴る間だけ BGM を下げる設定と -14 LUFS は本編と同じ。読み上げは先に -14 LUFS にそろえてあるので、混ぜる前に声を 13 dB 下げて本編（Kokoro の素の音量）と同じ釣り合いにする（BGM は声より 7〜9 dB 下）
  - 読み上げに失敗した日は BGM だけを入れる（ピークが 0 dB を超える曲があるので最後に約 -3 dB で抑える）。BGM が入らなかった日（ffmpeg が無い等）は BGM 無しで出す
  - 説明欄の帰属表示（`Music: "<曲名>" by Kevin MacLeod …`）は実際に入れた曲だけを書く。入った音は `remotion/out/map-<id>.audio.json` に残し、台帳の variant は `map` / `map-narrated` / `map-bgm` / `map-narrated-bgm`

## 投稿メタ
- title: `${shortTitle} 🌍 #shorts`（100 字以内）
- description: 地図の説明 1 行＋ `Source: <name> (<year>) <url>` ＋ `Map is schematic (Natural Earth, U.S. point-of-view borders); borders and territories simplified.` ＋ 既存の channel 行
- tags: map, geography, world, countries, ${id の語}, shorts
- 台帳: posted.json に追記。Drive の posted-ledger.json にも `format: "map"` で追記できるなら追記（collect-stats で news と分けて集計するため）

## 測り方（調査レポート P1 の計画）
- 指標: 投稿 7 日後の再生数の中央値（map 枠）vs 同期間の 60 秒本編の中央値（現状 ≈ 80）。期待: map 枠が本編の 2 倍以上
- 窓: 10/7〜10/31 の 11 本。やめる条件: 11 本の中央値が本編以下、またはコメント 0 が 8 本以上

## 下地の地図

- 2026-11-07 に world-atlas countries-110m から替えた。world-atlas（Natural Earth の標準版）はクリミアをロシアに含め、ソマリランドと北キプロスを別の形にし、西サハラの大半をモロッコに含める。
- 今の下地は Natural Earth v5.1.2 の米国視点版（`ne_10m_admin_0_countries_usa`・パブリックドメイン）。解説形式の地図（`assets/realmap/`）と同じ視点で、2026-11-01 にオーナーが選んだ。クリミア・ドネツクはウクライナ、ソマリランドはソマリア、北キプロスはキプロス、西サハラは別の地域（No data）、コソボは番号が無いので常に unknown 色。
- 作り方（mapshaper 0.6.102）:
  ```bash
  mapshaper -i ne_10m_admin_0_countries_usa.geojson name=countries -filter 'ADM0_A3 != "ATA"' -filter 'this.area > 2500e6' -each 'name = NAME_EN' \
    -filter-fields name,ISO_N3_EH -simplify 3% keep-shapes -o countries-ne-usa.json format=topojson id-field=ISO_N3_EH quantization=100000
  ```
  id は ISO 3166 の数字コード（content/maps/countries.json の ccn3 と同じ）。番号の無い形は -99 で、world.ts が unknown 色にする。
  2,500 km² 未満の地域は落とす（世界図では見えず、No data の件数だけ増えるため）。旧下地の 177 の形はすべて残り、180 になる。
