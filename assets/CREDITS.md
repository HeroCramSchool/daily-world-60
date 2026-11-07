# Asset credits

All background music is licensed and attributed in every video's YouTube description.

## news-bed.mp3 — daily Shorts BGM
- Track: **"Investigations"** by **Kevin MacLeod** (https://incompetech.com)
- License: **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Investigations.mp3
- Used by `scripts/build-news-video.ts` (daily 60s Shorts), mixed at ~10% under narration.
- Attribution auto-added in `buildYoutubeDescription` (`scripts/publish-all.ts`).

## news-bed-longform.mp3 — weekly Deep Dive BGM
- Track: **"Lightless Dawn"** by **Kevin MacLeod** (https://incompetech.com)
- License: **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Lightless%20Dawn.mp3
- Used by `scripts/build-longform-video.ts` (weekly 8-12min deep dive), mixed at ~8% under narration.
  Chosen as a serious / somber bed that fits hard-news deep dives.
- Attribution auto-added in `scripts/publish-longform.ts`.

## Controls
- `BGM_PATH` overrides the track path; `BGM_VOLUME` overrides loudness (longform default `0.08`, shorts `0.10`).
- Delete the file to disable BGM (renderer falls back to no music).
- To swap a track, replace the file and update the attribution line in the matching publish script.

## Section b-roll (long-form)
- Background images per section are fetched at render time from **Wikimedia Commons** (JPEG photos,
  CC/PD), matched to each section's `imageQuery`. Same source as the daily pipeline's b-roll.

## realmap/ — 解説形式の地図 (国境・海岸線・川・湖・海の名)
- Natural Earth v5.1.2（パブリックドメイン。帰属表示の義務なし） — https://www.naturalearthdata.com/about/terms-of-use/
- 国境は米国視点版 `ne_10m_admin_0_countries_usa`（クリミア・ドネツクはウクライナ、コソボは独立国。オーナーが 2026-11-01 に選択）。
  標準版はクリミアをロシア領に描くので使わない。
- 川 `ne_50m_rivers_lake_centerlines`（scalerank 6 以下）・湖 `ne_50m_lakes`（4 以下）・海の名 `ne_50m_geography_marine_polys`（4 以下・内側の点）。
- mapshaper 0.6.102 で軽くした（国境は頂点の 12% を残す）。作り方: docs/explainer.md の「地図」。

## remotion/public/maps/countries-ne-usa.json — 地図ショートの下地
- Natural Earth v5.1.2 `ne_10m_admin_0_countries_usa`（パブリックドメイン）を mapshaper で頂点の 3% に軽くしたもの。作り方は docs/map-short.md の「下地の地図」。
