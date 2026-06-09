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
