import { google } from "googleapis";

/**
 * Gmail から最新の認証コードを取得するヘルパー。
 *
 * Usage (CLI):
 *   npx tsx scripts/auth/get-verification-code.ts instagram
 *   npx tsx scripts/auth/get-verification-code.ts tiktok
 *   npx tsx scripts/auth/get-verification-code.ts x
 *
 * Programmatic:
 *   const code = await getVerificationCode("instagram");
 */

const SERVICE_QUERIES: Record<string, string> = {
  instagram: 'from:(security@mail.instagram.com OR no-reply@mail.instagram.com OR notify@instagram.com) subject:(verify OR code OR コード OR ログイン)',
  tiktok: 'from:(noreply@tiktok.com OR notify@tiktok.com OR account@tiktok.com) subject:(verify OR code OR コード)',
  x: 'from:(info@x.com OR verify@x.com OR notification@twitter.com) subject:(verify OR code OR コード OR confirm)',
  google: 'from:no-reply@accounts.google.com subject:(verify OR code OR セキュリティ)',
};

const RECEIVED_WITHIN_MS = 10 * 60 * 1000; // 10 minutes

export async function getVerificationCode(
  service: keyof typeof SERVICE_QUERIES,
  options?: { maxRetries?: number; retryDelayMs?: number },
): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Gmail credentials missing (GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN)");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const baseQuery = SERVICE_QUERIES[service];
  if (!baseQuery) throw new Error(`Unknown service: ${service}`);

  const maxRetries = options?.maxRetries ?? 12;
  const retryDelayMs = options?.retryDelayMs ?? 10_000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: `${baseQuery} newer_than:1h`,
      maxResults: 5,
    });

    const msgs = listRes.data.messages ?? [];
    for (const m of msgs) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "full",
      });
      const headers = detail.data.payload?.headers ?? [];
      const dateHeader = headers.find(h => h.name === "Date")?.value;
      const subject = headers.find(h => h.name === "Subject")?.value ?? "";
      const receivedMs = dateHeader ? new Date(dateHeader).getTime() : 0;
      if (Date.now() - receivedMs > RECEIVED_WITHIN_MS) continue;

      const body = extractBody(detail.data);
      const code = extractCode(subject + "\n" + body);
      if (code) return code;
    }

    if (attempt < maxRetries - 1) {
      console.log(`[gmail] no code yet (try ${attempt + 1}/${maxRetries}), waiting ${retryDelayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error(`No verification code found for ${service} in the last ${RECEIVED_WITHIN_MS / 60000} minutes`);
}

function extractBody(payload: unknown): string {
  const p = payload as { body?: { data?: string }; parts?: unknown[] };
  if (!p) return "";
  if (p.body?.data) {
    return Buffer.from(p.body.data, "base64").toString("utf-8");
  }
  if (p.parts) {
    for (const part of p.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}

function extractCode(text: string): string | null {
  // Strip HTML and decode entities (very rough)
  const stripped = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

  // Look for 6-digit codes (Instagram, TikTok, X all use 6 digits)
  const patterns = [
    /\b(\d{6})\b/g,            // 6-digit anywhere
    /code[^\d]{0,20}(\d{6})/i, // "code: 123456"
    /コード[^\d]{0,20}(\d{6})/, // 日本語 "コード: 123456"
    /\b(\d{4,8})\b/g,          // 4-8 digit fallback
  ];

  for (const pat of patterns) {
    const m = stripped.match(pat);
    if (m && m[1]) return m[1];
    if (m && m[0]) {
      const onlyDigits = m[0].replace(/\D/g, "");
      if (onlyDigits.length >= 4 && onlyDigits.length <= 8) return onlyDigits;
    }
  }
  return null;
}

// CLI entry point
async function cli() {
  const service = process.argv[2] as keyof typeof SERVICE_QUERIES;
  if (!service || !SERVICE_QUERIES[service]) {
    console.error(`Usage: npx tsx scripts/auth/get-verification-code.ts <${Object.keys(SERVICE_QUERIES).join("|")}>`);
    process.exit(1);
  }
  try {
    const code = await getVerificationCode(service);
    console.log(code);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
