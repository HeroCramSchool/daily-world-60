# Asset credits

## news-bed.mp3 (background music)

- Track: **"Investigations"** by **Kevin MacLeod** (https://incompetech.com)
- License: **Creative Commons Attribution 4.0 (CC BY 4.0)** — https://creativecommons.org/licenses/by/4.0/
- Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Investigations.mp3
- Usage: mixed under narration at ~10% volume in `scripts/build-news-video.ts`.
- **Attribution is auto-included** in every YouTube video description (see `buildYoutubeDescription` in `scripts/publish-all.ts`).

To swap the BGM: replace `assets/news-bed.mp3` (any audio ffmpeg can read), and update the attribution line in `buildYoutubeDescription` if the new track requires it. Set `BGM_PATH` to override the path, or `BGM_VOLUME` (default `0.10`) to change loudness. Remove the file to disable BGM.
