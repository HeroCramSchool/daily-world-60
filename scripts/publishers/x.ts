import { TwitterApi } from "twitter-api-v2";

export interface XPublishInput {
  thread: string[];
}

export interface XPublishResult {
  ok: boolean;
  url?: string;
  tweetIds?: string[];
  error?: string;
}

/**
 * X (Twitter) API v2 — post a thread (Japanese, posted to @60dailyworld).
 * Requires OAuth 1.0a user-context tokens.
 */
export async function publishX(input: XPublishInput): Promise<XPublishResult> {
  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!key || !secret || !accessToken || !accessSecret) {
    return { ok: false, error: "X credentials missing" };
  }
  if (!input.thread || input.thread.length === 0) {
    return { ok: false, error: "empty thread" };
  }

  const client = new TwitterApi({
    appKey: key,
    appSecret: secret,
    accessToken,
    accessSecret,
  });

  const tweetIds: string[] = [];
  let inReplyTo: string | undefined;

  try {
    for (const text of input.thread) {
      const r = await client.v2.tweet({
        text: text.slice(0, 280),
        ...(inReplyTo ? { reply: { in_reply_to_tweet_id: inReplyTo } } : {}),
      });
      tweetIds.push(r.data.id);
      inReplyTo = r.data.id;
    }
    const first = tweetIds[0];
    return {
      ok: true,
      tweetIds,
      url: `https://x.com/60dailyworld/status/${first}`,
    };
  } catch (e) {
    return {
      ok: false,
      tweetIds,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
