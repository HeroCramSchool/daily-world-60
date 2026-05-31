import { google } from "googleapis";

/**
 * YouTube から指定 videoId の動画を削除する。
 *
 * 使い方:
 *   YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... YOUTUBE_REFRESH_TOKEN=... \
 *     npx tsx scripts/delete-videos.ts <videoId1> <videoId2> ...
 *
 * または env で DELETE_VIDEO_IDS=id1,id2,id3 でも可。
 *
 * 注意: TikTok / Instagram / X は API なし → Studio Web UI で手動削除。
 */

async function main() {
  const idsFromArgs = process.argv.slice(2).filter(Boolean);
  const idsFromEnv = (process.env.DELETE_VIDEO_IDS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const ids = [...new Set([...idsFromArgs, ...idsFromEnv])];

  if (ids.length === 0) {
    console.error("Usage: npx tsx scripts/delete-videos.ts <videoId1> <videoId2> ...");
    console.error("   or: DELETE_VIDEO_IDS=id1,id2 npx tsx scripts/delete-videos.ts");
    process.exit(1);
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error("[delete] missing YOUTUBE_CLIENT_ID / _SECRET / _REFRESH_TOKEN");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  for (const id of ids) {
    try {
      console.log(`[delete] ${id} ...`);
      await youtube.videos.delete({ id });
      console.log(`[delete] ✓ deleted ${id}`);
    } catch (e) {
      console.error(`[delete] ✗ ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
