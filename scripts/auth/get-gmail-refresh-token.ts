import { google } from "googleapis";
import * as http from "node:http";
import * as url from "node:url";

/**
 * Gmail OAuth — get refresh_token for reading verification codes from emails.
 *
 * Usage:
 *   npx tsx scripts/auth/get-gmail-refresh-token.ts <CLIENT_ID> <CLIENT_SECRET>
 */

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

const PORT = 3737;
const REDIRECT = `http://localhost:${PORT}/callback`;

async function main() {
  const clientId = process.argv[2];
  const clientSecret = process.argv[3];
  if (!clientId || !clientSecret) {
    console.error("Usage: npx tsx scripts/auth/get-gmail-refresh-token.ts <CLIENT_ID> <CLIENT_SECRET>");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n=========================================");
  console.log("Open this URL in your browser (info@hero-english.net):");
  console.log(authUrl);
  console.log("=========================================\n");

  try {
    const { spawn } = await import("node:child_process");
    spawn("open", [authUrl]);
  } catch {
    /* ignore */
  }

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
        res.end("OK — refresh_token printed in terminal.");
        console.log("\n=========================================");
        console.log("Gmail refresh_token:");
        console.log(tokens.refresh_token);
        console.log("=========================================\n");
        setTimeout(() => {
          server.close();
          resolve();
        }, 500);
      } catch (e) {
        res.end(`error: ${e instanceof Error ? e.message : e}`);
      }
    });
    server.listen(PORT);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
