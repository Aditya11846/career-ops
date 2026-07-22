#!/usr/bin/env node
/**
 * apply-agent/session-store/login.mjs — one-time manual login for Tier 2
 *
 * Opens a REAL, ON-SCREEN (not off-screen, unlike the apply-session browser)
 * headed Chrome window on LinkedIn's or Naukri's login page. YOU log in
 * yourself — this script never sees, touches, or stores your password. Once
 * it detects you've reached a logged-in page, it saves the browser's cookies
 * + localStorage (Playwright "storageState") to session-store/{platform}.json
 * and closes. apply-agent/tier2/driver-core.mjs then reuses that file via
 * /api/apply/session's `platform` param — see that route for how it's wired.
 *
 * session-store/*.json is gitignored (see .gitignore) — never committed,
 * never synced between machines, exactly the same "on this machine only"
 * treatment as tracker-utils.mjs's lock files.
 *
 * Run with:
 *   node apply-agent/session-store/login.mjs linkedin
 *   node apply-agent/session-store/login.mjs naukri
 *
 * Sessions expire eventually (LinkedIn/Naukri both do this periodically) —
 * if Tier 2 starts hitting login-wall again after previously working,
 * just re-run this to refresh session-store/{platform}.json.
 */

import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_STORE_DIR = dirname(fileURLToPath(import.meta.url));

const PLATFORMS = {
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    // Any page under linkedin.com that isn't /login or /checkpoint (2FA/CAPTCHA
    // interstitials) counts as "logged in" — feed.mjs, /jobs, /mypreferences, etc.
    isLoggedIn: (u) => /linkedin\.com\//i.test(u) && !/\/(login|checkpoint|authwall)/i.test(u),
  },
  naukri: {
    loginUrl: 'https://www.naukri.com/nlogin/login',
    isLoggedIn: (u) => /naukri\.com\//i.test(u) && !/\/nlogin\/login/i.test(u),
  },
};

async function main() {
  const platform = process.argv[2];
  const cfg = PLATFORMS[platform];
  if (!cfg) {
    console.error(`Usage: node apply-agent/session-store/login.mjs <${Object.keys(PLATFORMS).join('|')}>`);
    process.exitCode = 1;
    return;
  }

  console.log(`Opening ${platform} login — log in yourself in the window that opens. Waiting up to 5 minutes...`);
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1280,940'] }).catch(
    () => chromium.launch({ headless: false, args: ['--window-size=1280,940'] }),
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 5 * 60_000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (cfg.isLoggedIn(page.url())) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    console.error('Timed out waiting for login (5 min). Nothing was saved — run again when ready.');
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // Give the post-login redirect a moment to settle (some cookies land async).
  await page.waitForTimeout(2000);
  const outPath = join(SESSION_STORE_DIR, `${platform}.json`);
  await context.storageState({ path: outPath });
  console.log(`Saved ${platform} session to ${outPath}. You can close the browser window now.`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
