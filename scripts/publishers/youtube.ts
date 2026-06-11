import * as fs from "node:fs";
import { google } from "googleapis";

export interface YouTubePublishInput {
  videoPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
  tags: string[];
  /** ISO 8601。指定時は private でアップし、YouTube がこの時刻に自動公開（予約公開）。 */
  publishAt?: string;
}

export interface YouTubePublishResult {
  ok: boolean;
  url?: string;
  videoId?: string;
  error?: string;
}

/**
 * YouTube Data API v3 — upload as public Shorts.
 * Requires OAuth refresh_token (long-lived).
 */
export async function publishYoutube(
  input: YouTubePublishInput,
): Promise<YouTubePublishResult> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      error: "YouTube credentials missing (YOUTUBE_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)",
    };
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  try {
    const uploadRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description.slice(0, 5000),
          tags: input.tags.slice(0, 15),
          categoryId: "25", // News & Politics
          defaultLanguage: "en",
          // auto-dubbing / 自動翻訳字幕の前提となる音声言語の明示
          defaultAudioLanguage: "en",
        },
        status: {
          // publishAt 指定時は private + 予約公開 (YouTube が時刻到来で自動 public 化)
          privacyStatus: input.publishAt ? "private" : "public",
          ...(input.publishAt ? { publishAt: input.publishAt } : {}),
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(input.videoPath) },
    });

    const videoId = uploadRes.data.id;
    if (!videoId) return { ok: false, error: "no videoId returned" };

    // Set thumbnail if provided
    if (input.thumbnailPath) {
      try {
        await youtube.thumbnails.set({
          videoId,
          media: { body: fs.createReadStream(input.thumbnailPath) },
        });
      } catch (e) {
        console.warn(`[youtube] thumbnail set failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      ok: true,
      videoId,
      url: `https://www.youtube.com/shorts/${videoId}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
