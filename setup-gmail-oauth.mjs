#!/usr/bin/env node
// One-time Gmail OAuth setup for the apply-agent's email-verification flow
// (secret-mcp-server.ts's await_verification_email tool + the `gmail` plugin's
// ingest hook) and ats-account.ts's waitForVerificationEmail(). Both read
// GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN from .env —
// this script is the missing piece that produces the refresh token.
//
// Standard OAuth 2.0 "installed application" flow with a loopback redirect:
// 1. You provide a Google Cloud OAuth Desktop client (client ID + secret) —
//    create one free at https://console.cloud.google.com/apis/credentials
//    (APIs & Services → Credentials → Create Credentials → OAuth client ID →
//    Application type: Desktop app). Enable the Gmail API for the project first.
// 2. This script opens a local HTTP server on a loopback port, prints the
//    Google consent URL, and waits for the redirect carrying the auth code.
// 3. It exchanges the code for a refresh token and writes all three vars to
//    .env (creating it if absent, never touching other keys).
//
// Usage:
//   node setup-gmail-oauth.mjs --client-id=... --client-secret=...
// or export GMAIL_SETUP_CLIENT_ID / GMAIL_SETUP_CLIENT_SECRET first.

import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, ".env");
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const PORT = 53682; // fixed loopback port registered as an authorized redirect URI

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

const clientId = arg("client-id") || process.env.GMAIL_SETUP_CLIENT_ID;
const clientSecret = arg("client-secret") || process.env.GMAIL_SETUP_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`
Missing OAuth client credentials. First, create a free Google Cloud OAuth
Desktop client (one-time, ~2 minutes):

  1. https://console.cloud.google.com/apis/library/gmail.googleapis.com
     → Enable the Gmail API (create a project first if you don't have one).
  2. https://console.cloud.google.com/apis/credentials
     → Create Credentials → OAuth client ID → Application type: "Desktop app".
  3. Under "Authorized redirect URIs" add EXACTLY:
       http://127.0.0.1:${PORT}/oauth2callback
  4. Copy the Client ID and Client Secret it gives you.

Then run:
  node setup-gmail-oauth.mjs --client-id=YOUR_ID --client-secret=YOUR_SECRET
`);
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${PORT}/oauth2callback`;
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // force refresh_token even on repeat runs

console.log("\nOpen this URL, sign in with the Google account whose inbox receives\nATS verification emails, and approve access:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect on ${redirectUri} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<h2>Denied: ${error}</h2>You can close this tab.`);
    console.error(`Consent denied: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Success — you can close this tab.</h2>");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      console.error("Token exchange failed:", data);
      console.error(
        data.error === "invalid_grant"
          ? "\nThe code was already used or expired — rerun this script."
          : "\nIf no refresh_token came back, revoke prior access at https://myaccount.google.com/permissions and rerun (Google only issues a refresh_token on first consent unless prompt=consent, which this script already sets)."
      );
      server.close();
      process.exit(1);
    }

    writeEnvVars({
      GMAIL_CLIENT_ID: clientId,
      GMAIL_CLIENT_SECRET: clientSecret,
      GMAIL_REFRESH_TOKEN: data.refresh_token,
    });
    console.log("\n✓ Wrote GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN to .env");
    console.log("Restart the dev server for the new .env values to load.\n");
  } catch (e) {
    console.error("Token exchange error:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1");

function writeEnvVars(vars) {
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, "utf8").split("\n");
  }
  for (const [key, value] of Object.entries(vars)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(ENV_PATH, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
}
