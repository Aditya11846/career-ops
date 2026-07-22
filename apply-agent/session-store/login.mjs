#!/usr/bin/env node
/**
 * apply-agent/session-store/login.mjs — capture a Tier 2 session from your
 * REAL Chrome profile (no automated sign-in — LinkedIn/Google block that)
 *
 * A prior version of this script drove an automated login flow directly;
 * LinkedIn/Google detect Playwright-controlled Chrome via CDP regardless of
 * headed/headless and hard-block sign-in ("this browser or app may not be
 * secure"). That's a legitimate anti-automation control, not something to
 * disguise around — this script no longer attempts a login at all.
 *
 * Instead: it copies your REAL Chrome profile (the one you're already
 * logged into LinkedIn/Naukri with, from normal daily browsing — never
 * your live profile directly, to avoid corrupting it or hitting Chrome's
 * single-instance profile lock), opens THAT copy in a visible Playwright
 * browser, confirms you're already logged in, saves just the session
 * cookies/localStorage (Playwright "storageState") to
 * session-store/{platform}.json, then deletes the profile copy — the saved
 * storageState is scoped to that one site's cookies, not your whole profile.
 *
 * PREREQUISITE: log into LinkedIn (or Naukri) in your normal, everyday
 * Chrome first, the regular way, before running this. Close Chrome before
 * running (copying a live profile mid-write can produce an inconsistent
 * copy).
 *
 * Run with:
 *   node apply-agent/session-store/login.mjs linkedin
 *   node apply-agent/session-store/login.mjs naukri
 *
 * Sessions expire eventually — re-run this (after logging in again in your
 * normal Chrome, if needed) to refresh session-store/{platform}.json.
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform as osPlatform } from 'node:os';

const SESSION_STORE_DIR = dirname(fileURLToPath(import.meta.url));

function chromeUserDataDir() {
  const home = homedir();
  switch (osPlatform()) {
    case 'darwin': return join(home, 'Library/Application Support/Google/Chrome');
    case 'win32': return join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
    default: return join(home, '.config/google-chrome'); // linux
  }
}

const PLATFORMS = {
  linkedin: {
    checkUrl: 'https://www.linkedin.com/feed/',
    isLoggedIn: (u) => /linkedin\.com\/feed/i.test(u),
    notLoggedInHint: 'Log into linkedin.com in your normal Chrome first, then re-run this.',
  },
  naukri: {
    checkUrl: 'https://www.naukri.com/mnjuser/homepage',
    isLoggedIn: (u) => /naukri\.com\/mnjuser/i.test(u),
    notLoggedInHint: 'Log into naukri.com in your normal Chrome first, then re-run this.',
  },
};

// Exclude the heavy, non-session-relevant parts of a Chrome profile (cache,
// GPU cache, service worker storage, extension binaries) — we only need
// cookies + local storage to survive into the profile copy.
const COPY_EXCLUDES = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Service Worker', 'Extensions', 'Extension State', 'GrShaderCache', 'ShaderCache']);

async function main() {
  const platform = process.argv[2];
  const cfg = PLATFORMS[platform];
  if (!cfg) {
    console.error(`Usage: node apply-agent/session-store/login.mjs <${Object.keys(PLATFORMS).join('|')}>`);
    process.exitCode = 1;
    return;
  }

  const sourceDir = chromeUserDataDir();
  if (!existsSync(sourceDir)) {
    console.error(`Couldn't find a Chrome profile at ${sourceDir}. Is Chrome installed?`);
    process.exitCode = 1;
    return;
  }

  const copyDir = join(SESSION_STORE_DIR, `.profile-copy-${platform}`);
  rmSync(copyDir, { recursive: true, force: true });
  mkdirSync(copyDir, { recursive: true });

  console.log(`Copying your Chrome profile (excluding cache/extensions) — this can take a minute...`);
  cpSync(sourceDir, copyDir, {
    recursive: true,
    filter: (src) => {
      const base = src.split('/').pop() || '';
      return !COPY_EXCLUDES.has(base);
    },
  });

  console.log('Opening the profile copy to check login status...');
  let context;
  try {
    context = await chromium.launchPersistentContext(copyDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 900 },
    }).catch(() =>
      chromium.launchPersistentContext(copyDir, { headless: false, viewport: { width: 1280, height: 900 } }),
    );
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(cfg.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);

    if (!cfg.isLoggedIn(page.url())) {
      console.error(`Not logged into ${platform} in your Chrome profile (landed on ${page.url()}). ${cfg.notLoggedInHint}`);
      process.exitCode = 1;
      return;
    }

    const outPath = join(SESSION_STORE_DIR, `${platform}.json`);
    await context.storageState({ path: outPath });
    console.log(`Saved ${platform} session to ${outPath}.`);
  } finally {
    await context?.close().catch(() => {});
    // Delete the full profile copy now — we only need the storageState JSON
    // going forward, and it holds far more (every site's cookies) than that.
    rmSync(copyDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
