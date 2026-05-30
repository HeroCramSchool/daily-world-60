import { google } from "googleapis";
import * as http from "node:http";
import * as url from "node:url";

/**
 * YouTube OAuth 2.0 — get refresh_token (ローカルで1回だけ実行)。
 *
 * 使い方:
 *   npx tsx scripts/auth/get-youtube-refresh-token.ts <CLIENT_ID> <CLIENT_SECRET>
 *
 * ブラウザが開いて Google ログイン → 承認 → ターミナルに refresh_token が出力される。
 */

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/callback`;

async function main() {
  const clientId = process.argv[2];
  const clientSecret = process.argv[3];
  if (!clientId || !clientSecret) {
    console.error("Usage: npx tsx scripts/auth/get-youtube-refresh-token.ts <CLIENT_ID> <CLIENT_SECRET>");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n=========================================");
  console.log("Open this URL in your browser (the Google account that manages @60dailyworld):");
  console.log(authUrl);
  console.log("=========================================\n");

  // Mac の場合自動で開く
  try {
    const { spawn } = await import("node:child_process");
    spawn("open", [authUrl]);
  } catch {
    /* ignore */
  }

  // 簡易 callback サーバ
  await new Promise<void>(resolve => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const parsed = url.parse(req.url, true);
        if (parsed.pathname !== "/callback") return;
        const code = parsed.query.code as string;
        if (!code) {
          res.end("No code");
          return;
        }
        const { tokens } = await oauth2.getToken(code);
        res.end("OK — you can close this window.\n\nrefresh_token has been printed in your terminal.");
        console.log("\n=========================================");
        console.log("refresh_token:");
        console.log(tokens.refresh_token);
        console.log("=========================================");
        console.log("\nSave this as GitHub Secret YOUTUBE_REFRESH_TOKEN.\n");
        setTimeout(() => {
          server.close();
          resolve();
        }, 500);
      } catch (e) {
        res.end(`error: ${e instanceof Error ? e.message : e}`);
      }
    });
    server.listen(PORT, () => console.log(`(local callback server on ${REDIRECT})`));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
